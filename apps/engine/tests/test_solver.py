"""
PyTest suite for the LunchLineup scheduling engine.
Covers BreakCalculator and ConstraintSolver — core algorithms.
"""
import pytest
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
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

    def test_default_long_shift_has_typed_rest_lunch_rest_breaks(self):
        start, end = self._shift(10.0)
        breaks = self.calc.calculate_breaks(start, end)
        assert [item["type"] for item in breaks] == ["break1", "lunch", "break2"]

    def test_break_duration_is_correct(self):
        start, end = self._shift(8.0)
        breaks = self.calc.calculate_breaks(start, end)
        assert next(item for item in breaks if item["type"] == "lunch")["duration_minutes"] == 30

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

    def test_custom_long_shift_threshold_and_durations_are_preserved(self):
        calc = BreakCalculator(rules={"min_shift_for_break": 7.0, "break_duration": 25,
                                      "min_shift_for_second_break": 12.0, "second_break_duration": 15,
                                      "paid_break_threshold": 20})
        start, end = self._shift(12.0)

        breaks = calc.calculate_breaks(start, end)

        assert [item["type"] for item in breaks] == ["break1", "lunch", "break2"]
        assert [item["duration_minutes"] for item in breaks] == [15, 25, 15]
        assert [item["paid"] for item in breaks] == [True, False, True]

    def test_paid_status_based_on_duration(self):
        """Breaks <= paid_break_threshold should be marked paid."""
        start, end = self._shift(8.0)
        breaks = self.calc.calculate_breaks(start, end)
        # Default: break_duration=30, paid_break_threshold=20 → 30 > 20 → unpaid
        lunch = next(item for item in breaks if item["type"] == "lunch")
        assert lunch["paid"] is False
        assert all(item["paid"] is True for item in breaks if item["type"] != "lunch")

    def test_paid_break_with_short_duration(self):
        calc = BreakCalculator(rules={"min_shift_for_break": 5.0, "break_duration": 15,
                                      "min_shift_for_second_break": 10.0, "second_break_duration": 15,
                                      "paid_break_threshold": 20})
        start, end = self._shift(6.0)
        breaks = calc.calculate_breaks(start, end)
        assert breaks[0]["paid"] is True, "15-minute break should be paid (under 20-min threshold)"

    @pytest.mark.parametrize("rules", [
        {"unknown_rule": 1},
        {"min_shift_for_break": "invalid"},
        {"min_shift_for_break": 0},
        ["not", "an", "object"],
    ])
    def test_rejects_invalid_break_rules(self, rules):
        with pytest.raises(ValueError):
            BreakCalculator(rules=rules)


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

    def test_accepts_utc_iso_instants_from_api(self):
        result = self.solver.solve(
            staff_ids=["alice"],
            start_date="2026-03-10T00:00:00.000Z",
            end_date="2026-03-11T00:00:00.000Z",
            constraints={"min_floor_coverage": 1, "shift_duration_hours": 4},
        )

        assert result["feasible"] is True
        assert result["assignments"][0]["start_time"].endswith("+00:00")

    def test_rejects_invalid_calendar_dates(self):
        result = self.solver.solve(
            staff_ids=["alice"],
            start_date="2026-02-30T00:00:00.000Z",
            end_date="2026-03-02T00:00:00.000Z",
        )

        assert result["feasible"] is False
        assert "valid ISO" in result["reason"]

    def test_rejects_blank_schedule_dates(self):
        result = self.solver.solve(
            staff_ids=["alice"],
            start_date="",
            end_date="2026-03-02T00:00:00.000Z",
        )

        assert result["feasible"] is False
        assert "ISO date or datetime string" in result["reason"]

    def test_feasible_single_employee_one_week(self):
        result = self.solver.solve(
            staff_ids=["alice"],
            start_date="2026-03-10",
            end_date="2026-03-17",
            constraints={"min_floor_coverage": 1, "shift_duration_hours": 4, "max_hours_per_week": 56},
        )
        assert result["feasible"] is True
        assert len(result["assignments"]) == 7, "One employee covering 7 days"

    def test_feasible_multiple_employees(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob", "carol"],
            start_date="2026-03-10",
            end_date="2026-03-17",
            constraints={"min_floor_coverage": 1, "shift_duration_hours": 4},
        )
        assert result["feasible"] is True
        # At least 7 assignments (one per day)
        assert len(result["assignments"]) >= 7

    def test_fairness_score_between_0_and_1(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-10",
            end_date="2026-03-17",
            constraints={"min_floor_coverage": 1, "shift_duration_hours": 4},
        )
        assert result["feasible"] is True
        assert 0.0 <= result["score"] <= 1.0

    def test_each_assignment_contains_breaks(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
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

    def test_existing_hours_force_assignment_to_staff_with_weekly_capacity(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-09T00:00:00Z",
            end_date="2026-03-10T00:00:00Z",
            constraints={
                "max_hours_per_week": 8,
                "shift_duration_hours": 4,
                "existing_weekly_minutes": {"alice": {"2026-03-09": 480}},
                "demand_windows": [{
                    "start_time": "2026-03-09T09:00:00Z",
                    "end_time": "2026-03-09T13:00:00Z",
                    "required_staff": 1,
                }],
            },
        )

        assert result["feasible"] is True
        assert {assignment["staff_id"] for assignment in result["assignments"]} == {"bob"}

    def test_cross_location_existing_shift_forces_nonoverlapping_assignment(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-09T00:00:00Z",
            end_date="2026-03-10T00:00:00Z",
            constraints={
                "demand_windows": [{
                    "start_time": "2026-03-09T09:00:00Z",
                    "end_time": "2026-03-09T13:00:00Z",
                    "required_staff": 1,
                }],
                "existing_shift_intervals": [{
                    "id": "shift-other-location",
                    "staff_id": "alice",
                    "location_id": "location-2",
                    "start_time": "2026-03-09T10:00:00Z",
                    "end_time": "2026-03-09T11:00:00Z",
                }],
                "existing_weekly_minutes": {"alice": {"2026-03-09": 60}},
            },
        )

        assert result["feasible"] is True
        assert {assignment["staff_id"] for assignment in result["assignments"]} == {"bob"}

    def test_demand_hours_use_location_calendar_weeks_when_window_starts_midweek(self):
        result = self.solver.solve(
            staff_ids=["alice"],
            start_date="2026-03-04T08:00:00Z",
            end_date="2026-03-10T07:00:00Z",
            constraints={
                "timezone": "America/Los_Angeles",
                "max_hours_per_week": 8,
                "shift_duration_hours": 4,
                "demand_windows": [
                    {
                        "start_time": "2026-03-04T17:00:00Z",
                        "end_time": "2026-03-04T21:00:00Z",
                        "required_staff": 1,
                    },
                    {
                        "start_time": "2026-03-08T16:00:00Z",
                        "end_time": "2026-03-08T20:00:00Z",
                        "required_staff": 1,
                    },
                    {
                        "start_time": "2026-03-09T16:00:00Z",
                        "end_time": "2026-03-09T20:00:00Z",
                        "required_staff": 1,
                    },
                ],
            },
        )

        assert result["feasible"] is True
        assert len(result["assignments"]) == 3

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

    def test_rejects_unsupported_constraints(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-10",
            end_date="2026-03-12",
            constraints={"min_floor_coverage": 1, "raw_sql": "select 1"},
        )

        assert result["feasible"] is False
        assert "Unsupported constraint" in result["reason"]

    def test_rejects_schedule_windows_above_saas_cap(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-01",
            end_date="2026-04-15",
            constraints={"min_floor_coverage": 1},
        )

        assert result["feasible"] is False
        assert "cannot exceed" in result["reason"]

    @pytest.mark.parametrize("constraints", [
        {"min_floor_coverage": 0},
        {"min_floor_coverage": 2},
        {"shift_duration_hours": 0},
        {"shift_duration_hours": 25},
        {"max_hours_per_week": 0},
        {"max_hours_per_week": 169},
        {"solver_time_limit_seconds": 0},
        {"max_hours_per_week": 4, "shift_duration_hours": 8},
        {"daily_demand": True},
        {"daily_demand": []},
        {"timezone": 1},
        {"timezone": "Not/A_Timezone"},
    ])
    def test_rejects_invalid_solver_constraints(self, constraints):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-09",
            end_date="2026-03-10",
            constraints=constraints,
        )

        assert result["feasible"] is False

    def test_rejects_oversized_staff_list_and_non_object_constraints(self):
        oversized = self.solver.solve(
            staff_ids=[f"staff-{index}" for index in range(201)],
            start_date="2026-03-09",
            end_date="2026-03-10",
        )
        invalid_constraints = self.solver.solve(
            staff_ids=["alice"],
            start_date="2026-03-09",
            end_date="2026-03-10",
            constraints=["not-an-object"],
        )

        assert oversized["feasible"] is False
        assert invalid_constraints["feasible"] is False

    def test_weekly_hours_apply_to_multiweek_windows(self):
        result = self.solver.solve(
            staff_ids=["alice"],
            start_date="2026-03-09",
            end_date="2026-03-23",
            constraints={
                "min_floor_coverage": 1,
                "shift_duration_hours": 6,
                "max_hours_per_week": 40,
                "break_rules": {"min_shift_for_break": 24},
            },
        )

        assert result["feasible"] is False
        assert "No feasible solution" in result["reason"]

    def test_staff_availability_limits_assignments(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-09",
            end_date="2026-03-11",
            constraints={
                "min_floor_coverage": 1,
                "shift_duration_hours": 4,
                "max_hours_per_week": 40,
                "availability": {
                    "alice": [{"day_of_week": "monday", "start_time": "08:00", "end_time": "18:00"}],
                    "bob": [{"day_of_week": "tuesday", "start_time": "08:00", "end_time": "18:00"}],
                },
            },
        )

        assert result["feasible"] is True
        by_date = {assignment["date"]: assignment["staff_id"] for assignment in result["assignments"]}
        assert by_date == {
            "2026-03-09": "alice",
            "2026-03-10": "bob",
        }

    def test_omitted_staff_availability_is_unrestricted(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-09",
            end_date="2026-03-11",
            constraints={
                "min_floor_coverage": 1,
                "shift_duration_hours": 4,
                "max_hours_per_week": 40,
                "availability": {
                    "alice": [{"day_of_week": "monday", "start_time": "08:00", "end_time": "18:00"}],
                },
            },
        )

        assert result["feasible"] is True
        tuesday_staff = {
            assignment["staff_id"]
            for assignment in result["assignments"]
            if assignment["date"] == "2026-03-10"
        }
        assert tuesday_staff == {"bob"}

    def test_explicit_empty_staff_availability_is_unavailable(self):
        result = self.solver.solve(
            staff_ids=["alice"],
            start_date="2026-03-09",
            end_date="2026-03-10",
            constraints={
                "min_floor_coverage": 1,
                "shift_duration_hours": 4,
                "availability": {"alice": []},
            },
        )

        assert result["feasible"] is False

    def test_location_timezone_preserves_local_days_and_emits_utc_instants_across_dst(self):
        result = self.solver.solve(
            staff_ids=["alice"],
            start_date="2026-03-08T08:00:00Z",
            end_date="2026-03-10T07:00:00Z",
            constraints={
                "timezone": "America/Los_Angeles",
                "shift_duration_hours": 4,
                "availability": {
                    "alice": [
                        {"day_of_week": "Sunday", "start_time": "09:00", "end_time": "17:00"},
                        {"day_of_week": "Monday", "start_time": "09:00", "end_time": "17:00"},
                    ],
                },
            },
        )

        assert result["feasible"] is True
        assert [assignment["date"] for assignment in result["assignments"]] == ["2026-03-08", "2026-03-09"]
        assert [assignment["start_time"] for assignment in result["assignments"]] == [
            "2026-03-08T16:00:00+00:00",
            "2026-03-09T16:00:00+00:00",
        ]

    def test_monday_overnight_availability_covers_tuesday_early_hours(self):
        time_zone = ZoneInfo("America/Los_Angeles")
        availability = self.solver._normalize_availability({
            "alice": [{"day_of_week": "Monday", "start_time": "22:00", "end_time": "02:00"}],
        }, ["alice"])

        assert self.solver._is_available(
            availability,
            "alice",
            datetime(2026, 3, 9, 22, tzinfo=time_zone),
            datetime(2026, 3, 9, 22, tzinfo=time_zone),
            datetime(2026, 3, 10, 2, tzinfo=time_zone),
        ) is True
        assert self.solver._is_available(
            availability,
            "alice",
            datetime(2026, 3, 9, 22, tzinfo=time_zone),
            datetime(2026, 3, 9, 22, tzinfo=time_zone),
            datetime(2026, 3, 10, 3, tzinfo=time_zone),
        ) is False

    def test_overnight_availability_uses_wall_clock_segments_across_dst_fallback(self):
        time_zone = ZoneInfo("America/Los_Angeles")
        availability = self.solver._normalize_availability({
            "alice": [{"day_of_week": "Saturday", "start_time": "22:00", "end_time": "02:00"}],
        }, ["alice"])

        assert self.solver._is_available(
            availability,
            "alice",
            datetime(2026, 10, 31, 22, tzinfo=time_zone),
            datetime(2026, 10, 31, 22, tzinfo=time_zone),
            datetime(2026, 11, 1, 2, tzinfo=time_zone),
        ) is True

    def test_skill_requirements_assign_qualified_staff(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-09",
            end_date="2026-03-11",
            constraints={
                "min_floor_coverage": 1,
                "shift_duration_hours": 4,
                "staff_skills": {
                    "alice": ["lead"],
                    "bob": ["prep"],
                },
                "skill_requirements": {"lead": 1},
            },
        )

        assert result["feasible"] is True
        assert {assignment["staff_id"] for assignment in result["assignments"]} == {"alice"}

    def test_daily_demand_can_require_extra_coverage_for_one_day(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-09",
            end_date="2026-03-11",
            constraints={
                "min_floor_coverage": 1,
                "daily_demand": {"2026-03-10": 2},
                "shift_duration_hours": 4,
            },
        )

        assert result["feasible"] is True
        counts_by_date = {}
        for assignment in result["assignments"]:
            counts_by_date[assignment["date"]] = counts_by_date.get(assignment["date"], 0) + 1
        assert counts_by_date["2026-03-09"] == 1
        assert counts_by_date["2026-03-10"] == 2

    def test_demand_windows_preserve_exact_times_and_required_skill(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-09T08:00:00Z",
            end_date="2026-03-10T07:00:00Z",
            constraints={
                "timezone": "America/Los_Angeles",
                "staff_skills": {"alice": ["lead"], "bob": ["prep"]},
                "demand_windows": [{
                    "id": "demand-1",
                    "start_time": "2026-03-09T18:30:00Z",
                    "end_time": "2026-03-09T23:15:00Z",
                    "required_staff": 1,
                    "skill": "lead",
                }],
            },
        )

        assert result["feasible"] is True
        assert result["assignments"] == [{
            "staff_id": "alice",
            "date": "2026-03-09",
            "start_time": "2026-03-09T18:30:00+00:00",
            "end_time": "2026-03-09T23:15:00+00:00",
            "role": "lead",
            "breaks": [],
        }]

    def test_demand_windows_reserve_relief_so_breaks_do_not_reduce_working_coverage(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-09T00:00:00Z",
            end_date="2026-03-10T00:00:00Z",
            constraints={
                "demand_windows": [{
                    "id": "demand-break-relief",
                    "start_time": "2026-03-09T09:00:00Z",
                    "end_time": "2026-03-09T17:00:00Z",
                    "required_staff": 1,
                }],
            },
        )

        assert result["feasible"] is True
        assert len(result["assignments"]) == 2
        breaks = sorted(
            (
                datetime.fromisoformat(assignment["breaks"][0]["start_time"]),
                datetime.fromisoformat(assignment["breaks"][0]["end_time"]),
            )
            for assignment in result["assignments"]
        )
        assert breaks[0][1] <= breaks[1][0]

    def test_adjacent_demand_segments_are_one_continuous_shift_for_break_rules(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-09T00:00:00Z",
            end_date="2026-03-10T00:00:00Z",
            constraints={
                "staff_skills": {"alice": ["cashier"], "bob": ["cashier"]},
                "demand_windows": [
                    {
                        "id": "morning",
                        "start_time": "2026-03-09T09:00:00Z",
                        "end_time": "2026-03-09T13:00:00Z",
                        "required_staff": 1,
                    },
                    {
                        "id": "afternoon",
                        "start_time": "2026-03-09T13:00:00Z",
                        "end_time": "2026-03-09T17:00:00Z",
                        "required_staff": 1,
                        "skill": "cashier",
                    },
                ],
            },
        )

        assert result["feasible"] is True
        assert len(result["assignments"]) == 2
        assert {assignment["start_time"] for assignment in result["assignments"]} == {"2026-03-09T09:00:00+00:00"}
        assert {assignment["end_time"] for assignment in result["assignments"]} == {"2026-03-09T17:00:00+00:00"}
        assert all(
            [item["type"] for item in assignment["breaks"]] == ["break1", "lunch", "break2"]
            for assignment in result["assignments"]
        )

    def test_demand_window_is_infeasible_when_only_worker_must_take_a_break(self):
        result = self.solver.solve(
            staff_ids=["alice"],
            start_date="2026-03-09T00:00:00Z",
            end_date="2026-03-10T00:00:00Z",
            constraints={
                "demand_windows": [{
                    "id": "demand-no-relief",
                    "start_time": "2026-03-09T09:00:00Z",
                    "end_time": "2026-03-09T17:00:00Z",
                    "required_staff": 1,
                }],
            },
        )

        assert result["feasible"] is False
        assert result["details"][0]["required"] == 2

    @pytest.mark.parametrize("demand_windows", [
        {},
        [None],
        [{"start_time": "2026-03-09T09:00:00Z", "end_time": "2026-03-09T10:00:00Z", "required_staff": 1, "unknown": True}],
        [{"start_time": "2026-03-08T09:00:00Z", "end_time": "2026-03-08T10:00:00Z", "required_staff": 1}],
        [{"start_time": "2026-03-09T09:00:00Z", "end_time": "2026-03-09T10:00:00Z", "required_staff": 1, "skill": ""}],
        [{"start_time": "2026-03-09T09:00:00Z", "end_time": "2026-03-09T10:00:00Z", "required_staff": 1}] * 501,
    ])
    def test_rejects_malformed_demand_windows(self, demand_windows):
        result = self.solver.solve(
            staff_ids=["alice"],
            start_date="2026-03-09T00:00:00Z",
            end_date="2026-03-10T00:00:00Z",
            constraints={"demand_windows": demand_windows},
        )

        assert result["feasible"] is False

    def test_demand_window_precheck_reports_coverage_and_skill_shortfalls(self):
        result = self.solver.solve(
            staff_ids=["alice"],
            start_date="2026-03-09T00:00:00Z",
            end_date="2026-03-10T00:00:00Z",
            constraints={
                "staff_skills": {"alice": ["prep"]},
                "demand_windows": [{
                    "start_time": "2026-03-09T09:00:00Z",
                    "end_time": "2026-03-09T17:00:00Z",
                    "required_staff": 2,
                    "skill": "lead",
                }],
            },
        )

        assert result["feasible"] is False
        assert {detail["code"] for detail in result["details"]} == {
            "coverage_demand_unstaffed",
            "skill_demand_unstaffed",
        }

    def test_overlapping_general_demand_windows_use_union_maximum(self):
        availability = {
            "alice": [{"day_of_week": "monday", "start_time": "08:00", "end_time": "18:00"}],
            "bob": [{"day_of_week": "monday", "start_time": "00:00", "end_time": "01:00"}],
            "carol": [{"day_of_week": "monday", "start_time": "00:00", "end_time": "01:00"}],
        }
        result = self.solver.solve(
            staff_ids=["alice", "bob", "carol"],
            start_date="2026-03-09T00:00:00Z",
            end_date="2026-03-10T00:00:00Z",
            constraints={
                "availability": availability,
                "break_rules": {"min_shift_for_break": 24},
                "demand_windows": [
                    {
                        "start_time": "2026-03-09T09:00:00Z",
                        "end_time": "2026-03-09T13:00:00Z",
                        "required_staff": 1,
                    },
                    {
                        "start_time": "2026-03-09T12:00:00Z",
                        "end_time": "2026-03-09T16:00:00Z",
                        "required_staff": 1,
                    },
                ],
            },
        )

        assert result["feasible"] is True
        assert {assignment["staff_id"] for assignment in result["assignments"]} == {"alice"}

    def test_overlapping_general_and_cashier_demand_share_the_skilled_worker(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-09T00:00:00Z",
            end_date="2026-03-10T00:00:00Z",
            constraints={
                "staff_skills": {"alice": ["cashier"], "bob": []},
                "demand_windows": [
                    {
                        "start_time": "2026-03-09T09:00:00Z",
                        "end_time": "2026-03-09T13:00:00Z",
                        "required_staff": 2,
                    },
                    {
                        "start_time": "2026-03-09T10:00:00Z",
                        "end_time": "2026-03-09T12:00:00Z",
                        "required_staff": 1,
                        "skill": "cashier",
                    },
                ],
            },
        )

        assert result["feasible"] is True
        overlap = [
            assignment for assignment in result["assignments"]
            if assignment["start_time"] == "2026-03-09T10:00:00+00:00"
            and assignment["end_time"] == "2026-03-09T12:00:00+00:00"
        ]
        assert {assignment["staff_id"] for assignment in overlap} == {"alice", "bob"}
        assert next(assignment for assignment in overlap if assignment["staff_id"] == "alice")["role"] == "cashier"

    def test_overlapping_independent_skill_demands_keep_each_skill_covered(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-09T00:00:00Z",
            end_date="2026-03-10T00:00:00Z",
            constraints={
                "staff_skills": {"alice": ["cashier"], "bob": ["grill"]},
                "demand_windows": [
                    {
                        "start_time": "2026-03-09T09:00:00Z",
                        "end_time": "2026-03-09T12:00:00Z",
                        "required_staff": 1,
                        "skill": "cashier",
                    },
                    {
                        "start_time": "2026-03-09T10:00:00Z",
                        "end_time": "2026-03-09T13:00:00Z",
                        "required_staff": 1,
                        "skill": "grill",
                    },
                ],
            },
        )

        assert result["feasible"] is True
        overlap = [
            assignment for assignment in result["assignments"]
            if assignment["start_time"] == "2026-03-09T10:00:00+00:00"
            and assignment["end_time"] == "2026-03-09T12:00:00+00:00"
        ]
        assert {assignment["staff_id"] for assignment in overlap} == {"alice", "bob"}
        assert {assignment["role"] for assignment in overlap} == {"cashier", "grill"}

    def test_demand_windows_respect_weekly_hour_limit(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob"],
            start_date="2026-03-09T00:00:00Z",
            end_date="2026-03-10T00:00:00Z",
            constraints={
                "max_hours_per_week": 4,
                "shift_duration_hours": 4,
                "demand_windows": [{
                    "start_time": "2026-03-09T09:00:00Z",
                    "end_time": "2026-03-09T17:00:00Z",
                    "required_staff": 1,
                }],
            },
        )

        assert result["feasible"] is False
        assert "demand-window constraints" in result["reason"]

    def test_unstaffed_skill_requirement_returns_structured_details(self):
        result = self.solver.solve(
            staff_ids=["alice"],
            start_date="2026-03-09",
            end_date="2026-03-10",
            constraints={
                "min_floor_coverage": 1,
                "shift_duration_hours": 4,
                "staff_skills": {"alice": ["prep"]},
                "skill_requirements": {"lead": 1},
            },
        )

        assert result["feasible"] is False
        assert result["details"][0]["code"] == "skill_demand_unstaffed"
        assert result["details"][0]["skill"] == "lead"
        assert result["details"][0]["required"] == 1
        assert result["details"][0]["available"] == 0

    def test_breaks_are_staggered_for_same_day_assignments(self):
        result = self.solver.solve(
            staff_ids=["alice", "bob", "carol"],
            start_date="2026-03-09",
            end_date="2026-03-10",
            constraints={"min_floor_coverage": 2, "shift_duration_hours": 8},
        )

        assert result["feasible"] is True
        breaks = [
            (
                datetime.fromisoformat(assignment["breaks"][0]["start_time"]),
                datetime.fromisoformat(assignment["breaks"][0]["end_time"]),
            )
            for assignment in result["assignments"]
        ]
        assert len(breaks) == 3
        ordered = sorted(breaks)
        assert all(left[1] <= right[0] for left, right in zip(ordered, ordered[1:]))
