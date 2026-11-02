# SPDX-FileCopyrightText: 2025-2026 Tyrone Ross, Jr <46267523+tyroneross@users.noreply.github.com>
# SPDX-License-Identifier: Apache-2.0
"""Measure a handoff by what the next session actually remembers.

A handoff is good when a session that starts from it can answer the questions
the previous session would have to answer to keep working: where the work is,
what was verified, what is not done, what needs the owner. This tool turns
that into a graded quiz.

Quiz file (`bookmark.handoff-quiz.v1`):

    {"schema": "bookmark.handoff-quiz.v1",
     "handoff": "/abs/path/.bookmark/bookmark.context.md",
     "pass_score": 0.8,
     "questions": [
       {"id": "head", "question": "Which commit is local main at?",
        "expect_all": [["64197d8"]],          # every group must match; any alternative in a group
        "forbid": ["pushed to origin"],       # a match fails the answer (a confident wrong claim)
        "weight": 1}]}

Two ways to take the quiz:

  prompt       Instructions for a NEW session, run right after it starts and
               before it opens any file: it answers from what the session start
               gave it. Measures the whole restore path (hooks + handoff).
  cold-prompt  The handoff file's text plus the quiz, for a reader with no other
               context (a fresh subagent). Measures the handoff file alone.

Both expect the answer as JSON: {"answers": {"<id>": "<text>", ...}}.

  grade        Score answers against the quiz. Exit 0 when the weighted score
               reaches pass_score, 1 otherwise. --json for machine output.
               Correct answers earn their weight; forbidden claims subtract it;
               all other outcomes earn zero. Scores can therefore be negative.

Matching is case-insensitive substring matching after whitespace
normalisation, deliberately simple so a reader can predict a grade. A failed
question names the expected facts it missed: that list is the handoff's gap.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

SCHEMA = "bookmark.handoff-quiz.v1"

ANSWER_RULES = (
    "Answer each question from what you already know. Do not open files, run "
    "commands or search before answering; the point is to measure what reached you. "
    "If you do not know, answer exactly \"unknown\" — a confident wrong answer "
    "scores worse than unknown. Reply with only this JSON object and nothing else:\n"
    '{"answers": {"<question id>": "<short answer>", ...}}'
)


def load_quiz(path: Path) -> dict:
    quiz = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(quiz, dict) or quiz.get("schema") != SCHEMA:
        raise ValueError(f"{path}: schema must be {SCHEMA}")
    pass_score = quiz.get("pass_score", 0.8)
    if not _finite_number(pass_score) or not 0 <= pass_score <= 1:
        raise ValueError("pass_score must be a finite number between 0 and 1")
    if not isinstance(quiz.get("questions"), list):
        raise ValueError("questions must be a list")
    seen = set()
    for q in quiz.get("questions", []):
        if not isinstance(q, dict):
            raise ValueError("each question must be an object")
        for key in ("id", "question", "expect_all"):
            if key not in q:
                raise ValueError(f"question {q.get('id', '?')}: missing {key}")
        if not all(isinstance(q[key], str) and q[key].strip() for key in ("id", "question")):
            raise ValueError("question id and question must be non-empty strings")
        if q["id"] in seen:
            raise ValueError(f"duplicate question id {q['id']}")
        seen.add(q["id"])
        groups = q["expect_all"]
        if not isinstance(groups, list) or not groups or not all(_fact_list(g) for g in groups):
            raise ValueError(f"question {q['id']}: expect_all must contain non-empty lists of facts")
        if "forbid" in q and not _fact_list(q["forbid"], allow_empty=True):
            raise ValueError(f"question {q['id']}: forbid must be a list of non-empty strings")
        weight = q.get("weight", 1)
        if not _finite_number(weight) or weight <= 0:
            raise ValueError(f"question {q['id']}: weight must be finite and positive")
    if not seen:
        raise ValueError("quiz has no questions")
    return quiz


def _finite_number(value: object) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _fact_list(value: object, *, allow_empty: bool = False) -> bool:
    return (isinstance(value, list) and (allow_empty or bool(value))
            and all(isinstance(fact, str) and fact.strip() for fact in value))


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", str(text)).strip().lower()


def grade_one(q: dict, answer: str | None) -> dict:
    text = _norm(answer or "")
    unknown = text in ("", "unknown")
    missing = [g for g in q["expect_all"] if not any(_norm(alt) in text for alt in g)]
    forbidden = [f for f in q.get("forbid", []) if _norm(f) in text]
    passed = not unknown and not missing and not forbidden
    if passed:
        outcome = "pass"
    elif forbidden:
        outcome = "wrong"  # asserted something the handoff should have ruled out
    elif unknown:
        outcome = "unknown"
    else:
        outcome = "partial" if len(missing) < len(q["expect_all"]) else "miss"
    return {"id": q["id"], "outcome": outcome, "weight": q.get("weight", 1),
            "missing": [g[0] for g in missing], "forbidden_hits": forbidden}


def grade(quiz: dict, answers: dict) -> dict:
    got = answers.get("answers", answers)
    rows = [grade_one(q, got.get(q["id"])) for q in quiz["questions"]]
    total = sum(r["weight"] for r in rows)
    earned = sum(r["weight"] for r in rows if r["outcome"] == "pass")
    earned -= sum(r["weight"] for r in rows if r["outcome"] == "wrong")
    score = earned / total if total else 0.0
    return {"score": round(score, 3), "pass_score": quiz.get("pass_score", 0.8),
            "passed": score >= quiz.get("pass_score", 0.8), "questions": rows,
            "gaps": [{"id": r["id"], "missing": r["missing"], "wrong": r["forbidden_hits"]}
                     for r in rows if r["outcome"] != "pass"]}


def quiz_block(quiz: dict) -> str:
    return "\n".join(f"- {q['id']}: {q['question']}" for q in quiz["questions"])


def cmd_prompt(quiz: dict) -> str:
    return f"Handoff recall check.\n{ANSWER_RULES}\n\nQuestions:\n{quiz_block(quiz)}\n"


def cmd_cold_prompt(quiz: dict, handoff: Path) -> str:
    text = handoff.read_text(encoding="utf-8")
    return (
        "You are a new session. The only thing you know about prior work is this handoff file:\n"
        f"<handoff path=\"{handoff}\">\n{text}\n</handoff>\n\n{cmd_prompt(quiz)}"
    )


def render(result: dict) -> str:
    lines = [f"score {result['score']:.0%} (pass at {result['pass_score']:.0%}) — {'PASS' if result['passed'] else 'FAIL'}"]
    for r in result["questions"]:
        detail = ""
        if r["missing"]:
            detail += " missing: " + "; ".join(r["missing"])
        if r["forbidden_hits"]:
            detail += " asserted: " + "; ".join(r["forbidden_hits"])
        lines.append(f"  {r['outcome']:<8} {r['id']}{detail}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("prompt", "cold-prompt", "grade"):
        p = sub.add_parser(name)
        p.add_argument("--quiz", required=True, type=Path)
        if name == "cold-prompt":
            p.add_argument("--handoff", type=Path, help="defaults to the quiz's handoff path")
        if name == "grade":
            p.add_argument("--answers", required=True, type=Path)
            p.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    quiz = load_quiz(a.quiz)
    if a.cmd == "prompt":
        print(cmd_prompt(quiz))
        return 0
    if a.cmd == "cold-prompt":
        handoff = a.handoff or Path(quiz["handoff"])
        print(cmd_cold_prompt(quiz, handoff))
        return 0
    raw = a.answers.read_text(encoding="utf-8")
    match = re.search(r"\{.*\}", raw, re.S)  # tolerate prose or code fences around the JSON
    if not match:
        print("answers file holds no JSON object", file=sys.stderr)
        return 2
    result = grade(quiz, json.loads(match.group(0)))
    print(json.dumps(result, indent=2) if a.json else render(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
