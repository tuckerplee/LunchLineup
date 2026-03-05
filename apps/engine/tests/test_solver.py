"""
PyTest suite for the LunchLineup scheduling engine.
Covers BreakCalculator and ConstraintSolver — core algorithms.
"""
import pytest
from datetime import datetime, timedelta
from src.solver.logic import BreakCalculator, ConstraintSolver


# ─── BreakCalculator ─────────────────────────────────────────────────────────

class TestBreakCalculator:
    """Tests for labor-law-compliant break calculation."""

    def setup_method(self):
        self.calc = BreakCalculator()

    def _shift(self, duration_hours: float):
        """Helper: returns (start, end) for a shift of given length."""
        start = datetime(2026, 3, 10, 9, 0, 0)
        return start, start + timedelta(hours=duration_hours)

    def test_no_breaks_for_short_shift(self):
        start, end = self._shift(4.0)
        breaks = self.calc.calculate_breaks(start, end)
        assert breaks == [], "Shifts under 5h should have no mandatory breaks"

    def test_one_break_for_five_hour_shift(self):
        start, end = self._shift(5.0)
        breaks = self.calc.calculate_breaks(start, end)
        assert len(breaks) == 1, "A 5h shift should have exactly 1 break"

    def test_two_breaks_for_ten_hour_shift(self):
        start, end = self._shift(10.0)
        breaks = self.calc.calculate_breaks(start, end)
        assert len(breaks) == 2, "A 10h shift should have 2 breaks"

    def test_break_duration_is_correct(self):
        start, end = self._shift(8.0)
        breaks = self.calc.calculate_breaks(start, end)
        assert breaks[0]["duration_minutes"] == 30

    def test_break_within_shift_window(self):
        start, end = self._shift(8.0)
        breaks = self.calc.calculate_breaks(start, end)
        for brk in breaks:
            brk_start = datetime.fromisoformat(brk["start_time"])
            brk_end = datetime.fromisoformat(brk["end_time"])
            assert brk_start >= start, "Break must start after shift start"
            assert brk_end <= end, "Break must end before shift end"

    def test_custom_break_rules(self):
        """Custom rules: no break required until 7 hours."""
        calc = BreakCalculator(rules={"min_shift_for_break": 7.0, "break_duration": 20,
                                      "min_shift_for_second_break": 12.0, "second_break_duration": 20,
                                      "paid_break_threshold": 20})
        start, end = self._shift(6.0)
        breaks = calc.calculate_breaks(start, end)
        assert breaks == [], "With custom rules, 6h should have no break"

    def test_paid_status_based_on_duration(self):
        """Breaks <= paid_break_threshold should be marked paid."""
        start, end = self._shift(8.0)
        breaks = self.calc.calculate_breaks(start, end)
        # Default: break_duration=30, paid_break_threshold=20 → 30 > 20 → unpaid
        assert breaks[0]["paid"] is False

    def test_paid_break_with_short_duration(self):
        calc = BreakCalculator(rules={"min_shift_for_break": 5.0, "break_duration": 15,
                                      "min_shift_for_second_break": 10.0, "second_break_duration": 15,
                                      "paid_break_threshold": 20})
        start, end = self._shift(6.0)
        breaks = calc.calculate_breaks(start, end)
        assert breaks[0]["paid"] is True, "15-minute break should be paid (under 20-min threshold)"


# ─── ConstraintSolver ────────────────────────────────────────────────────────

class TestConstraintSolver:
    """Tests for the OR-Tools CP-SAT constraint solver."""

    def setup_method(self):
        self.solver = ConstraintSolver()

    def test_returns_infeasible_for_no_staff(self):
        result = self.solver.solve(
            staff_ids=[],
            start_date="2026-03-10",
            end_date="2026-03-17",
        )
        assert result["feasible"] is False
        assert "No staff" in result["reason"]

    def test_returns_infeasible_for_invalid_date_range(self):
        result = self.solver.solve(
            staff_ids=["s1", "s2"],
            start_date="2026-03-17",
            end_date="2026-03-10",  # end before start
        )
        assert result["feasible"] is False

    def test_feasible_single_employee_one_week(self):
        result = self.solver.solve(
            staff_ids=["alice"],
            start_date="2026-03-10",
            end_date="2026-03-17",
            constraints={"min_floor_coverage": 1, "shift_duration_hours": 8},
        )
        assert result["feasible"] is True
        assert len(result["assignments"]) == 7, "One employee covering 7 days"

    def test_feasible_multiple_employees(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob", "carol"],
            start_date="2026-03-10",
            end_date="2026-03-17",
            constraints={"min_floor_coverage": 1, "shift_duration_hours": 8},
        )
        assert result["feasible"] is True
        # At least 7 assignments (one per day)
        assert len(result["assignments"]) >= 7

    def test_fairness_score_between_0_and_1(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-10",
            end_date="2026-03-17",
            constraints={"min_floor_coverage": 1, "shift_duration_hours": 8},
        )
        assert result["feasible"] is True
        assert 0.0 <= result["score"] <= 1.0

    def test_each_assignment_contains_breaks(self):
        result = self.solver.solve(
            staff_ids=["alice"],
            start_date="2026-03-10",
            end_date="2026-03-11",
            constraints={"min_floor_coverage": 1, "shift_duration_hours": 8},
        )
        assert result["feasible"] is True
        for assignment in result["assignments"]:
            # 8h shift meets the 5h threshold → should have at least 1 break
            assert "breaks" in assignment
            assert len(assignment["breaks"]) >= 1

    def test_max_hours_per_week_respected(self):
        """With max_hours_per_week=8 and 8h shifts, each employee should only get 1 shift."""
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-10",
            end_date="2026-03-17",
            constraints={"min_floor_coverage": 1, "shift_duration_hours": 8, "max_hours_per_week": 8},
        )
        # Each employee can only work 1 shift (8h/8h = 1)
        alice_shifts = [a for a in result.get("assignments", []) if a["staff_id"] == "alice"]
        bob_shifts = [a for a in result.get("assignments", []) if a["staff_id"] == "bob"]
        assert len(alice_shifts) <= 1
        assert len(bob_shifts) <= 1

    def test_stats_returned_when_feasible(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-10",
            end_date="2026-03-14",
            constraints={"min_floor_coverage": 1, "shift_duration_hours": 8},
        )
        assert "stats" in result
        assert "total_assignments" in result["stats"]
        assert "staff_hours" in result["stats"]
        assert "alice" in result["stats"]["staff_hours"]
