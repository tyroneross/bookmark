# SPDX-FileCopyrightText: 2025-2026 Tyrone Ross, Jr <46267523+tyroneross@users.noreply.github.com>
# SPDX-License-Identifier: Apache-2.0
"""Tests for the handoff recall grader, on synthetic quizzes only."""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location("handoff_recall", Path(__file__).with_name("handoff_recall.py"))
hr = importlib.util.module_from_spec(_SPEC)
sys.modules["handoff_recall"] = hr
_SPEC.loader.exec_module(hr)

QUIZ = {
    "schema": hr.SCHEMA,
    "handoff": "/tmp/none.md",
    "pass_score": 0.75,
    "questions": [
        {"id": "head", "question": "commit?", "expect_all": [["64197d8"]]},
        {"id": "push", "question": "pushed?", "expect_all": [["not pushed", "unpushed"]], "forbid": ["pushed to origin"]},
        {"id": "tests", "question": "tests?", "expect_all": [["491"], ["golden 48", "48 of 57", "found 48"]], "weight": 2},
    ],
}


def test_all_correct_passes_and_matching_ignores_case_and_spacing():
    r = hr.grade(QUIZ, {"answers": {"head": "Main is at 64197D8", "push": "Not   pushed", "tests": "491 passed; golden found 48"}})
    assert r["score"] == 1.0 and r["passed"] and r["gaps"] == []


def test_partial_and_missing_name_the_facts_the_handoff_lost():
    r = hr.grade(QUIZ, {"answers": {"head": "64197d8", "push": "not pushed", "tests": "491 tests"}})
    row = {q["id"]: q for q in r["questions"]}["tests"]
    assert row["outcome"] == "partial" and row["missing"] == ["golden 48"]
    assert r["score"] == 0.5 and not r["passed"]


def test_a_confident_wrong_claim_is_scored_as_wrong_not_partial():
    r = hr.grade(QUIZ, {"answers": {"head": "64197d8", "push": "unpushed, then pushed to origin", "tests": "unknown"}})
    rows = {q["id"]: q["outcome"] for q in r["questions"]}
    assert rows == {"head": "pass", "push": "wrong", "tests": "unknown"}


def test_quiz_validation_rejects_malformed_quizzes(tmp_path):
    bad = dict(QUIZ, questions=[{"id": "a", "question": "q", "expect_all": [[]]}])
    p = tmp_path / "q.json"
    p.write_text(json.dumps(bad))
    with pytest.raises(ValueError):
        hr.load_quiz(p)
    p.write_text(json.dumps(dict(QUIZ, schema="other")))
    with pytest.raises(ValueError):
        hr.load_quiz(p)


def test_cli_grade_tolerates_fenced_json_and_sets_exit_code(tmp_path):
    q = tmp_path / "quiz.json"
    q.write_text(json.dumps(QUIZ))
    a = tmp_path / "answers.txt"
    a.write_text('Here you go:\n```json\n{"answers": {"head": "64197d8", "push": "not pushed", "tests": "491, golden 48"}}\n```')
    assert hr.main(["grade", "--quiz", str(q), "--answers", str(a)]) == 0
    a.write_text('{"answers": {}}')
    assert hr.main(["grade", "--quiz", str(q), "--answers", str(a)]) == 1


def test_cold_prompt_embeds_the_handoff_and_every_question(tmp_path):
    h = tmp_path / "bookmark.context.md"
    h.write_text("BOOKMARK_IDENTITY: head=64197d8")
    text = hr.cmd_cold_prompt(QUIZ, h)
    assert "head=64197d8" in text and all(f"- {q['id']}:" in text for q in QUIZ["questions"])
    assert "unknown" in text  # the reader is told not to guess
