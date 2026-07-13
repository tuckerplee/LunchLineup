"""
Core scheduling solver and break calculator.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
import logging
import re
from typing import Any, Dict, Iterable, List, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

logger = logging.getLogger("engine.solver")

MAX_STAFF_IDS = 200
MAX_SCHEDULE_DAYS = 31
MAX_SOLVER_SECONDS = 15.0
MAX_CONSTRAINTS = 20
MAX_ID_LENGTH = 128
MAX_DEMAND_WINDOWS = 500
STAFF_ID_RE = re.compile(r"^[A-Za-z0-9._:@+-]{1,128}$")
ALLOWED_CONSTRAINTS = {
    "availability",
    "break_rules",
    "daily_demand",
    "demand_windows",
    "existing_weekly_minutes",
    "existing_shift_intervals",
    "max_hours_per_week",
    "min_floor_coverage",
    "shift_duration_hours",
    "skill_requirements",
    "solver_time_limit_seconds",
    "staff_skills",
    "timezone",
}
DAY_INDEX = {
    "monday": 0,
    "mon": 0,
    "tuesday": 1,
    "tue": 1,
    "wednesday": 2,
    "wed": 2,
    "thursday": 3,
    "thu": 3,
    "friday": 4,
    "fri": 4,
    "saturday": 5,
    "sat": 5,
    "sunday": 6,
    "sun": 6,
}


def parse_schedule_datetime(value: str, field: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be an ISO date or datetime string")
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError(f"{field} must be a valid ISO date or datetime string") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


class BreakCalculator:
    """
    Calculate mandatory breaks based on tenant-configurable labor rules.
    """

    DEFAULT_RULES = {
        "min_shift_for_break": 5.0,
        "break_duration": 30,
        "min_shift_for_second_break": 8.0,
        "second_break_duration": 10,
        "paid_break_threshold": 20,
    }

    def __init__(self, rules: Optional[Dict[str, Any]] = None):
        self.rules = self._normalize_rules(rules or {})

    def _normalize_rules(self, rules: Dict[str, Any]) -> Dict[str, float]:
        if not isinstance(rules, dict):
            raise ValueError("break_rules must be an object")
        unknown = set(rules) - set(self.DEFAULT_RULES)
        if unknown:
            raise ValueError(f"Unsupported break rule: {sorted(unknown)[0]}")

        normalized: Dict[str, float] = {}
        for key, default in self.DEFAULT_RULES.items():
            raw_value = rules.get(key, default)
            try:
                value = float(raw_value)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"{key} must be numeric") from exc
            if value <= 0:
                raise ValueError(f"{key} must be greater than 0")
            normalized[key] = value
        return normalized

    def calculate_breaks(
        self,
        start_time: datetime,
        end_time: datetime,
        stagger_index: int = 0,
    ) -> List[Dict[str, Any]]:
        """Calculate required breaks for a shift."""
        duration_hours = (end_time - start_time).total_seconds() / 3600
        breaks = []

        if duration_hours >= self.rules["min_shift_for_second_break"]:
            rest_duration = int(self.rules["second_break_duration"])
            lunch_duration = int(self.rules["break_duration"])
            break_specs = [
                ("break1", start_time + (end_time - start_time) / 4, rest_duration),
                ("lunch", start_time + (end_time - start_time) / 2, lunch_duration),
                ("break2", start_time + (end_time - start_time) * 3 / 4, rest_duration),
            ]
            for break_type, preferred_start, break_duration in break_specs:
                break_start = self._stagger_break_start(
                    preferred_start,
                    end_time,
                    break_duration,
                    stagger_index,
                )
                breaks.append({
                    "start_time": break_start.isoformat(),
                    "end_time": (break_start + timedelta(minutes=break_duration)).isoformat(),
                    "duration_minutes": break_duration,
                    "paid": break_duration <= self.rules["paid_break_threshold"],
                    "type": break_type,
                })
            return breaks

        if duration_hours >= self.rules["min_shift_for_break"]:
            midpoint = start_time + (end_time - start_time) / 2
            break_duration = int(self.rules["break_duration"])
            midpoint = self._stagger_break_start(midpoint, end_time, break_duration, stagger_index)
            break_end = midpoint + timedelta(minutes=break_duration)
            breaks.append({
                "start_time": midpoint.isoformat(),
                "end_time": break_end.isoformat(),
                "duration_minutes": break_duration,
                "paid": break_duration <= self.rules["paid_break_threshold"],
                "type": "lunch",
            })

        return breaks

    def requires_relief(self, start_time: datetime, end_time: datetime) -> bool:
        duration_hours = (end_time - start_time).total_seconds() / 3600
        return (
            duration_hours >= self.rules["min_shift_for_break"]
            or duration_hours >= self.rules["min_shift_for_second_break"]
        )

    def _stagger_break_start(
        self,
        preferred_start: datetime,
        shift_end: datetime,
        duration_minutes: int,
        stagger_index: int,
    ) -> datetime:
        if stagger_index <= 0:
            return preferred_start
        latest_start = shift_end - timedelta(minutes=duration_minutes)
        candidate = preferred_start + timedelta(minutes=duration_minutes * stagger_index)
        return min(candidate, latest_start)


class ConstraintSolver:
    """
    Constraint-based scheduling solver using Google OR-Tools CP-SAT.
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}

    def solve(
        self,
        staff_ids: List[str],
        start_date: str,
        end_date: str,
        constraints: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        from ortools.sat.python import cp_model

        try:
            staff_ids = self._normalize_staff_ids(staff_ids)
            constraints = self._normalize_constraints(constraints or {})
        except ValueError as e:
            return {"assignments": [], "score": 0.0, "feasible": False, "reason": str(e)}

        if not staff_ids:
            return {"assignments": [], "score": 0.0, "feasible": False, "reason": "No staff available"}

        try:
            schedule_time_zone = self._normalize_time_zone(constraints.get("timezone"))
            start = parse_schedule_datetime(start_date, "start_date").astimezone(schedule_time_zone)
            end = parse_schedule_datetime(end_date, "end_date").astimezone(schedule_time_zone)
            num_days = (end.date() - start.date()).days
            if num_days <= 0:
                raise ValueError("End date must be after start date")
            if num_days > MAX_SCHEDULE_DAYS:
                raise ValueError(f"Schedule window cannot exceed {MAX_SCHEDULE_DAYS} days")
        except ValueError as e:
            return {"assignments": [], "score": 0.0, "feasible": False, "reason": str(e)}

        try:
            min_coverage = int(constraints.get("min_floor_coverage", 1))
            shift_duration_hours = float(constraints.get("shift_duration_hours", 8))
            max_hours_per_week = float(constraints.get("max_hours_per_week", 40))
            solver_time_limit = float(constraints.get("solver_time_limit_seconds", 10.0))
            if min_coverage < 1:
                raise ValueError("min_floor_coverage must be at least 1")
            if min_coverage > len(staff_ids):
                raise ValueError("min_floor_coverage cannot exceed available staff")
            if shift_duration_hours <= 0:
                raise ValueError("shift_duration_hours must be greater than 0")
            if shift_duration_hours > 24:
                raise ValueError("shift_duration_hours cannot exceed 24")
            if max_hours_per_week <= 0:
                raise ValueError("max_hours_per_week must be greater than 0")
            if max_hours_per_week > 168:
                raise ValueError("max_hours_per_week cannot exceed 168")
            if solver_time_limit <= 0:
                raise ValueError("solver_time_limit_seconds must be greater than 0")
            solver_time_limit = min(solver_time_limit, MAX_SOLVER_SECONDS)
            max_shifts_per_week = int(max_hours_per_week // shift_duration_hours)
            if max_shifts_per_week < 1:
                raise ValueError("max_hours_per_week does not allow one full shift")
            break_calculator = BreakCalculator(constraints.get("break_rules") or self.config.get("break_rules"))
            availability = self._normalize_availability(constraints.get("availability"), staff_ids)
            daily_demand = self._normalize_daily_demand(constraints.get("daily_demand"))
            staff_skills = self._normalize_staff_skills(constraints.get("staff_skills"), staff_ids)
            existing_weekly_minutes = self._normalize_existing_weekly_minutes(
                constraints.get("existing_weekly_minutes"),
                staff_ids,
            )
            existing_shift_intervals = self._normalize_existing_shift_intervals(
                constraints.get("existing_shift_intervals"), staff_ids, start, end,
            )
            skill_requirements = self._normalize_skill_requirements(constraints.get("skill_requirements"))
            demand_windows = self._normalize_demand_windows(
                constraints.get("demand_windows"),
                start.astimezone(timezone.utc),
                end.astimezone(timezone.utc),
            )
        except (TypeError, ValueError) as e:
            return {"assignments": [], "score": 0.0, "feasible": False, "reason": str(e)}

        if demand_windows:
            return self._solve_demand_windows(
                cp_model,
                staff_ids,
                demand_windows,
                schedule_time_zone,
                availability,
                staff_skills,
                existing_weekly_minutes,
                existing_shift_intervals,
                max_hours_per_week,
                solver_time_limit,
                break_calculator,
            )

        infeasible_details = self._precheck_demand_requirements(
            staff_ids,
            start,
            num_days,
            min_coverage,
            daily_demand,
            staff_skills,
            skill_requirements,
            availability,
            shift_duration_hours,
            break_calculator,
        )
        if infeasible_details:
            return {
                "assignments": [],
                "score": 0.0,
                "feasible": False,
                "reason": "Demand cannot be satisfied with available staff and skills",
                "details": infeasible_details,
            }

        model = cp_model.CpModel()

        shifts = {}
        for staff_index, staff_id in enumerate(staff_ids):
            for day_index in range(num_days):
                shifts[(staff_id, day_index)] = model.NewBoolVar(f"shift_s{staff_index}_d{day_index}")

        for day_index in range(num_days):
            current_date = start + timedelta(days=day_index)
            day_coverage = self._coverage_for_day(daily_demand, current_date, min_coverage)
            shift_start = current_date.replace(hour=9, minute=0, second=0, microsecond=0)
            shift_end = shift_start + timedelta(hours=shift_duration_hours)
            relief = 1 if break_calculator.requires_relief(shift_start, shift_end) else 0
            model.Add(sum(shifts[(staff_id, day_index)] for staff_id in staff_ids) >= day_coverage + relief)

        for day_index in range(num_days):
            current_date = start + timedelta(days=day_index)
            shift_start = current_date.replace(hour=9, minute=0, second=0, microsecond=0)
            shift_end = shift_start + timedelta(hours=shift_duration_hours)
            for staff_id in staff_ids:
                if availability is not None and not self._is_available(
                    availability,
                    staff_id,
                    current_date,
                    shift_start,
                    shift_end,
                ):
                    model.Add(shifts[(staff_id, day_index)] == 0)

        for day_index in range(num_days):
            current_date = start + timedelta(days=day_index)
            shift_start = current_date.replace(hour=9, minute=0, second=0, microsecond=0)
            shift_end = shift_start + timedelta(hours=shift_duration_hours)
            relief = 1 if break_calculator.requires_relief(shift_start, shift_end) else 0
            for skill, required_count in self._skill_requirements_for_day(skill_requirements, current_date).items():
                eligible_staff = [staff_id for staff_id in staff_ids if skill in staff_skills.get(staff_id, set())]
                model.Add(sum(shifts[(staff_id, day_index)] for staff_id in eligible_staff) >= required_count + relief)

        max_week_minutes = int(round(max_hours_per_week * 60))
        generated_intervals = [
            (
                (start + timedelta(days=day_index)).replace(hour=9, minute=0, second=0, microsecond=0),
                (start + timedelta(days=day_index)).replace(hour=9, minute=0, second=0, microsecond=0)
                + timedelta(hours=shift_duration_hours),
            )
            for day_index in range(num_days)
        ]
        for week_date, week_start, week_end in self._calendar_weeks(
            start.astimezone(timezone.utc),
            end.astimezone(timezone.utc),
            schedule_time_zone,
        ):
            for staff_id in staff_ids:
                weighted_assignments = []
                for day_index, (shift_start, shift_end) in enumerate(generated_intervals):
                    overlap_minutes = self._overlap_minutes(shift_start, shift_end, week_start, week_end)
                    if overlap_minutes:
                        weighted_assignments.append(overlap_minutes * shifts[(staff_id, day_index)])
                existing_minutes = existing_weekly_minutes.get(staff_id, {}).get(week_date, 0)
                model.Add(sum(weighted_assignments) + existing_minutes <= max_week_minutes)

        max_shifts = model.NewIntVar(0, num_days, "max_shifts")
        for staff_id in staff_ids:
            model.Add(sum(shifts[(staff_id, day_index)] for day_index in range(num_days)) <= max_shifts)
        total_assignments = sum(shifts.values())
        model.Minimize(total_assignments * (num_days + 1) + max_shifts)

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = solver_time_limit
        solver.parameters.num_search_workers = int(self.config.get("num_search_workers", 4))
        status = solver.Solve(model)

        assignments = []
        staff_hours: Dict[str, float] = {staff_id: 0.0 for staff_id in staff_ids}

        if status == cp_model.OPTIMAL or status == cp_model.FEASIBLE:
            for day_index in range(num_days):
                current_date = start + timedelta(days=day_index)
                assigned_staff_ids = [
                    staff_id
                    for staff_id in staff_ids
                    if solver.Value(shifts[(staff_id, day_index)]) == 1
                ]
                for stagger_index, staff_id in enumerate(assigned_staff_ids):
                    shift_start = current_date.replace(hour=9, minute=0, second=0, microsecond=0)
                    shift_end = shift_start + timedelta(hours=shift_duration_hours)
                    breaks = break_calculator.calculate_breaks(shift_start, shift_end, stagger_index=stagger_index)

                    assignments.append({
                        "staff_id": staff_id,
                        "date": current_date.date().isoformat(),
                        "start_time": shift_start.astimezone(timezone.utc).isoformat(),
                        "end_time": shift_end.astimezone(timezone.utc).isoformat(),
                        "breaks": self._breaks_as_utc(breaks),
                    })
                    staff_hours[staff_id] += shift_duration_hours

            validation_windows = []
            for day_index in range(num_days):
                current_date = start + timedelta(days=day_index)
                shift_start = current_date.replace(hour=9, minute=0, second=0, microsecond=0)
                validation_windows.append({
                    "start_time": shift_start.astimezone(timezone.utc),
                    "end_time": (shift_start + timedelta(hours=shift_duration_hours)).astimezone(timezone.utc),
                    "required_staff": self._coverage_for_day(daily_demand, current_date, min_coverage),
                    "skill_requirements": self._skill_requirements_for_day(skill_requirements, current_date),
                })
            coverage_gaps = self._working_coverage_gaps(assignments, validation_windows, staff_skills)
            if coverage_gaps:
                return {
                    "assignments": [],
                    "score": 0.0,
                    "feasible": False,
                    "reason": "Break placement leaves demand coverage gaps",
                    "details": coverage_gaps[:20],
                }

            hours_variance = max(staff_hours.values()) - min(staff_hours.values()) if staff_hours else 0
            fairness_score = max(0.0, 1.0 - (hours_variance / max_hours_per_week))
            return {
                "assignments": assignments,
                "score": round(fairness_score, 3),
                "feasible": True,
                "stats": {
                    "total_assignments": len(assignments),
                    "staff_hours": staff_hours,
                    "fairness_score": round(fairness_score, 3),
                },
            }

        if status == cp_model.UNKNOWN:
            return {
                "assignments": [],
                "score": 0.0,
                "feasible": False,
                "reason": f"Solver did not find a solution within {solver_time_limit:g} seconds",
            }

        return {"assignments": [], "score": 0.0, "feasible": False, "reason": "No feasible solution found under constraints"}

    def _normalize_staff_ids(self, staff_ids: List[str]) -> List[str]:
        if not isinstance(staff_ids, list):
            raise ValueError("staff_ids must be a list")
        if len(staff_ids) > MAX_STAFF_IDS:
            raise ValueError(f"staff_ids cannot exceed {MAX_STAFF_IDS}")

        normalized: List[str] = []
        seen = set()
        for staff_id in staff_ids:
            if not isinstance(staff_id, str):
                raise ValueError("staff_ids must contain only strings")
            trimmed = staff_id.strip()
            if not trimmed or len(trimmed) > MAX_ID_LENGTH or not STAFF_ID_RE.match(trimmed):
                raise ValueError("staff_ids contain an invalid identifier")
            if trimmed not in seen:
                normalized.append(trimmed)
                seen.add(trimmed)
        return normalized

    def _normalize_constraints(self, constraints: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(constraints, dict):
            raise ValueError("constraints must be an object")
        if len(constraints) > MAX_CONSTRAINTS:
            raise ValueError(f"constraints cannot exceed {MAX_CONSTRAINTS} entries")
        unknown = set(constraints) - ALLOWED_CONSTRAINTS
        if unknown:
            raise ValueError(f"Unsupported constraint: {sorted(unknown)[0]}")
        return constraints

    def _normalize_daily_demand(self, demand: Any) -> Dict[str, int]:
        if demand is None:
            return {}
        if isinstance(demand, bool):
            raise ValueError("daily_demand must be a positive integer or object")
        if isinstance(demand, (int, float, str)):
            return {"*": self._parse_positive_int(demand, "daily_demand")}
        if not isinstance(demand, dict):
            raise ValueError("daily_demand must be a positive integer or object")

        normalized: Dict[str, int] = {}
        for bucket, raw_count in demand.items():
            normalized[self._normalize_requirement_bucket(bucket)] = self._parse_positive_int(
                raw_count,
                "daily_demand",
            )
        return normalized

    def _normalize_demand_windows(
        self,
        value: Any,
        schedule_start: datetime,
        schedule_end: datetime,
    ) -> List[Dict[str, Any]]:
        if value is None:
            return []
        if not isinstance(value, list):
            raise ValueError("demand_windows must be a list")
        if len(value) > MAX_DEMAND_WINDOWS:
            raise ValueError(f"demand_windows cannot exceed {MAX_DEMAND_WINDOWS} entries")

        normalized_windows = []
        boundaries = set()
        for index, raw_window in enumerate(value):
            if not isinstance(raw_window, dict):
                raise ValueError("demand window must be an object")
            unknown = set(raw_window) - {"id", "start_time", "end_time", "required_staff", "skill"}
            if unknown:
                raise ValueError(f"Unsupported demand window field: {sorted(unknown)[0]}")
            start_time = parse_schedule_datetime(raw_window.get("start_time"), f"demand_windows[{index}].start_time")
            end_time = parse_schedule_datetime(raw_window.get("end_time"), f"demand_windows[{index}].end_time")
            if not (schedule_start <= start_time < end_time <= schedule_end):
                raise ValueError("demand window must be inside the schedule window")
            required_staff = self._parse_positive_int(raw_window.get("required_staff"), "demand window required_staff")
            skill_value = raw_window.get("skill")
            skill = None
            if skill_value is not None:
                if not isinstance(skill_value, str) or not skill_value.strip() or len(skill_value.strip()) > 128:
                    raise ValueError("demand window skill must be a non-empty string")
                skill = skill_value.strip().lower()

            normalized_windows.append({
                "start_time": start_time,
                "end_time": end_time,
                "required_staff": required_staff,
                "skill": skill,
            })
            boundaries.update((start_time, end_time))

        ordered_boundaries = sorted(boundaries)
        protected_boundaries = {
            boundary
            for boundary in ordered_boundaries[1:-1]
            if any(window["start_time"] < boundary < window["end_time"] for window in normalized_windows)
        }
        segments = []
        for boundary_index in range(len(ordered_boundaries) - 1):
            segment_start = ordered_boundaries[boundary_index]
            segment_end = ordered_boundaries[boundary_index + 1]
            active = [
                window
                for window in normalized_windows
                if window["start_time"] < segment_end and window["end_time"] > segment_start
            ]
            if not active:
                continue
            skill_requirements: Dict[str, int] = {}
            for window in active:
                skill = window["skill"]
                if skill:
                    skill_requirements[skill] = max(
                        skill_requirements.get(skill, 0),
                        window["required_staff"],
                    )
            segment = {
                "start_time": segment_start,
                "end_time": segment_end,
                "required_staff": max(window["required_staff"] for window in active),
                "skill_requirements": skill_requirements,
                "protect_start": segment_start in protected_boundaries,
            }
            if (
                segments
                and segments[-1]["end_time"] == segment_start
                and segments[-1]["required_staff"] == segment["required_staff"]
                and segments[-1]["skill_requirements"] == segment["skill_requirements"]
            ):
                segments[-1]["end_time"] = segment_end
            else:
                segments.append(segment)
        return segments

    def _solve_demand_windows(
        self,
        cp_model: Any,
        staff_ids: List[str],
        demand_windows: List[Dict[str, Any]],
        schedule_time_zone: ZoneInfo,
        availability: Optional[Dict[str, List[Dict[str, Any]]]],
        staff_skills: Dict[str, set[str]],
        existing_weekly_minutes: Dict[str, Dict[str, int]],
        existing_shift_intervals: Dict[str, List[tuple[datetime, datetime]]],
        max_hours_per_week: float,
        solver_time_limit: float,
        break_calculator: BreakCalculator,
    ) -> Dict[str, Any]:
        details = []
        for slot_index, slot in enumerate(demand_windows):
            local_start = slot["start_time"].astimezone(schedule_time_zone)
            local_end = slot["end_time"].astimezone(schedule_time_zone)
            available_staff = [
                staff_id
                for staff_id in staff_ids
                if availability is None or self._is_available(
                    availability,
                    staff_id,
                    local_start,
                    local_start,
                    local_end,
                )
                if not self._has_existing_shift_overlap(
                    existing_shift_intervals, staff_id, slot["start_time"], slot["end_time"]
                )
            ]
            continuous_start, continuous_end = self._continuous_demand_span(demand_windows, slot_index)
            relief = 1 if break_calculator.requires_relief(continuous_start, continuous_end) else 0
            if slot["required_staff"] + relief > len(available_staff):
                details.append({
                    "code": "coverage_demand_unstaffed",
                    "date": local_start.date().isoformat(),
                    "required": slot["required_staff"] + relief,
                    "available": len(available_staff),
                    "message": "Demand window coverage exceeds available staff",
                })
            for skill, required_count in slot["skill_requirements"].items():
                available_with_skill = [
                    staff_id for staff_id in available_staff if skill in staff_skills.get(staff_id, set())
                ]
                if required_count + relief > len(available_with_skill):
                    details.append({
                        "code": "skill_demand_unstaffed",
                        "date": local_start.date().isoformat(),
                        "skill": skill,
                        "required": required_count + relief,
                        "available": len(available_with_skill),
                        "message": "Demand window skill requirement exceeds available qualified staff",
                    })
        if details:
            return {
                "assignments": [],
                "score": 0.0,
                "feasible": False,
                "reason": "Demand cannot be satisfied with available staff and skills",
                "details": details[:20],
            }

        model = cp_model.CpModel()
        assignments_by_slot = {
            (staff_id, slot_index): model.NewBoolVar(f"window_s{staff_index}_w{slot_index}")
            for staff_index, staff_id in enumerate(staff_ids)
            for slot_index in range(len(demand_windows))
        }

        for slot_index, slot in enumerate(demand_windows):
            continuous_start, continuous_end = self._continuous_demand_span(demand_windows, slot_index)
            relief = 1 if break_calculator.requires_relief(continuous_start, continuous_end) else 0
            model.Add(sum(assignments_by_slot[(staff_id, slot_index)] for staff_id in staff_ids) >= slot["required_staff"] + relief)
            local_start = slot["start_time"].astimezone(schedule_time_zone)
            local_end = slot["end_time"].astimezone(schedule_time_zone)
            for staff_id in staff_ids:
                if availability is not None and not self._is_available(
                    availability,
                    staff_id,
                    local_start,
                    local_start,
                    local_end,
                ):
                    model.Add(assignments_by_slot[(staff_id, slot_index)] == 0)
                if self._has_existing_shift_overlap(
                    existing_shift_intervals, staff_id, slot["start_time"], slot["end_time"]
                ):
                    model.Add(assignments_by_slot[(staff_id, slot_index)] == 0)
            for skill, required_count in slot["skill_requirements"].items():
                eligible = [staff_id for staff_id in staff_ids if skill in staff_skills.get(staff_id, set())]
                model.Add(sum(assignments_by_slot[(staff_id, slot_index)] for staff_id in eligible) >= required_count + relief)

        max_week_minutes = int(round(max_hours_per_week * 60))
        for week_date, week_start, week_end in self._calendar_weeks(
            min(slot["start_time"] for slot in demand_windows),
            max(slot["end_time"] for slot in demand_windows),
            schedule_time_zone,
        ):
            for staff_id in staff_ids:
                weighted_assignments = []
                for slot_index, slot in enumerate(demand_windows):
                    overlap_minutes = self._overlap_minutes(
                        slot["start_time"], slot["end_time"], week_start, week_end,
                    )
                    if overlap_minutes:
                        weighted_assignments.append(overlap_minutes * assignments_by_slot[(staff_id, slot_index)])
                existing_minutes = existing_weekly_minutes.get(staff_id, {}).get(week_date, 0)
                model.Add(sum(weighted_assignments) + existing_minutes <= max_week_minutes)

        duration_minutes = [
            max(1, int(round((slot["end_time"] - slot["start_time"]).total_seconds() / 60)))
            for slot in demand_windows
        ]
        total_window_minutes = sum(duration_minutes)
        max_staff_minutes = model.NewIntVar(0, total_window_minutes, "max_staff_minutes")
        for staff_id in staff_ids:
            model.Add(
                sum(duration_minutes[index] * assignments_by_slot[(staff_id, index)] for index in range(len(demand_windows)))
                <= max_staff_minutes
            )
        total_assignments = sum(assignments_by_slot.values())
        model.Minimize(total_assignments * (total_window_minutes + 1) + max_staff_minutes)

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = solver_time_limit
        solver.parameters.num_search_workers = int(self.config.get("num_search_workers", 4))
        status = solver.Solve(model)
        if status not in {cp_model.OPTIMAL, cp_model.FEASIBLE}:
            reason = (
                f"Solver did not find a solution within {solver_time_limit:g} seconds"
                if status == cp_model.UNKNOWN
                else "No feasible solution found under demand-window constraints"
            )
            return {"assignments": [], "score": 0.0, "feasible": False, "reason": reason}

        assignments = []
        staff_hours: Dict[str, float] = {staff_id: 0.0 for staff_id in staff_ids}
        for slot_index, slot in enumerate(demand_windows):
            assigned_staff = [
                staff_id
                for staff_id in staff_ids
                if solver.Value(assignments_by_slot[(staff_id, slot_index)]) == 1
            ]
            required_skills = sorted(slot["skill_requirements"])
            for stagger_index, staff_id in enumerate(assigned_staff):
                role = next(
                    (skill for skill in required_skills if skill in staff_skills.get(staff_id, set())),
                    "STAFF",
                )
                assignments.append({
                    "staff_id": staff_id,
                    "date": slot["start_time"].astimezone(schedule_time_zone).date().isoformat(),
                    "start_time": slot["start_time"].isoformat(),
                    "end_time": slot["end_time"].isoformat(),
                    "role": role,
                    "breaks": [],
                })
                staff_hours[staff_id] += duration_minutes[slot_index] / 60

        assignments = self._coalesce_continuous_assignments(
            assignments,
            break_calculator,
            schedule_time_zone,
            staff_ids,
            {
                slot["start_time"]
                for slot in demand_windows
                if slot.get("protect_start")
            },
        )
        coverage_gaps = self._working_coverage_gaps(assignments, demand_windows, staff_skills)
        if coverage_gaps:
            return {
                "assignments": [],
                "score": 0.0,
                "feasible": False,
                "reason": "Break placement leaves demand coverage gaps",
                "details": coverage_gaps[:20],
            }

        hours_variance = max(staff_hours.values()) - min(staff_hours.values()) if staff_hours else 0
        fairness_score = max(0.0, 1.0 - (hours_variance / max_hours_per_week))
        return {
            "assignments": assignments,
            "score": round(fairness_score, 3),
            "feasible": True,
            "stats": {
                "total_assignments": len(assignments),
                "staff_hours": staff_hours,
                "fairness_score": round(fairness_score, 3),
            },
        }

    def _continuous_demand_span(
        self,
        demand_windows: List[Dict[str, Any]],
        slot_index: int,
    ) -> tuple[datetime, datetime]:
        start_index = slot_index
        end_index = slot_index
        while (
            start_index > 0
            and demand_windows[start_index - 1]["end_time"] == demand_windows[start_index]["start_time"]
        ):
            start_index -= 1
        while (
            end_index + 1 < len(demand_windows)
            and demand_windows[end_index]["end_time"] == demand_windows[end_index + 1]["start_time"]
        ):
            end_index += 1
        return demand_windows[start_index]["start_time"], demand_windows[end_index]["end_time"]

    def _coalesce_continuous_assignments(
        self,
        assignments: List[Dict[str, Any]],
        break_calculator: BreakCalculator,
        schedule_time_zone: ZoneInfo,
        staff_ids: List[str],
        protected_boundaries: Optional[set[datetime]] = None,
    ) -> List[Dict[str, Any]]:
        protected_boundaries = protected_boundaries or set()
        by_staff: Dict[str, List[Dict[str, Any]]] = {}
        for assignment in assignments:
            by_staff.setdefault(assignment["staff_id"], []).append(dict(assignment))

        runs: List[List[Dict[str, Any]]] = []
        for staff_id, staff_assignments in by_staff.items():
            ordered = sorted(staff_assignments, key=lambda item: (item["start_time"], item["end_time"]))
            current_run: List[Dict[str, Any]] = []
            for assignment in ordered:
                if current_run and current_run[-1]["end_time"] != assignment["start_time"]:
                    runs.append(current_run)
                    current_run = []
                current_run.append(assignment)
            if current_run:
                runs.append(current_run)

        staff_order = {staff_id: index for index, staff_id in enumerate(staff_ids)}
        span_counts: Dict[tuple[str, str], int] = {}
        result: List[Dict[str, Any]] = []
        for run in sorted(
            runs,
            key=lambda items: (
                items[0]["start_time"],
                items[-1]["end_time"],
                staff_order.get(items[0]["staff_id"], 0),
            ),
        ):
            run_start = parse_schedule_datetime(run[0]["start_time"], "assignment start_time")
            run_end = parse_schedule_datetime(run[-1]["end_time"], "assignment end_time")
            span_key = (run[0]["start_time"], run[-1]["end_time"])
            stagger_index = span_counts.get(span_key, 0)
            span_counts[span_key] = stagger_index + 1
            run_breaks = self._breaks_as_utc(
                break_calculator.calculate_breaks(run_start, run_end, stagger_index=stagger_index)
            )

            merged_run: List[Dict[str, Any]] = []
            for assignment in run:
                boundary = parse_schedule_datetime(assignment["start_time"], "assignment start_time")
                if merged_run and boundary not in protected_boundaries:
                    current = merged_run[-1]
                    current["end_time"] = assignment["end_time"]
                    if current.get("role") != assignment.get("role"):
                        current["role"] = "STAFF"
                else:
                    merged_run.append(dict(assignment))

            for assignment in merged_run:
                start = parse_schedule_datetime(assignment["start_time"], "assignment start_time")
                end = parse_schedule_datetime(assignment["end_time"], "assignment end_time")
                assignment["date"] = start.astimezone(schedule_time_zone).date().isoformat()
                assignment["breaks"] = [
                    item
                    for item in run_breaks
                    if parse_schedule_datetime(item["start_time"], "break start_time") < end
                    and parse_schedule_datetime(item["end_time"], "break end_time") > start
                ]
                result.append(assignment)
        return sorted(
            result,
            key=lambda item: (item["start_time"], item["end_time"], staff_order.get(item["staff_id"], 0)),
        )

    def _normalize_time_zone(self, value: Any) -> ZoneInfo:
        if value is None:
            return ZoneInfo("UTC")
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > 128:
            raise ValueError("timezone must be a valid IANA timezone")
        try:
            return ZoneInfo(value.strip())
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("timezone must be a valid IANA timezone") from exc

    def _breaks_as_utc(self, breaks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [
            {
                **item,
                "start_time": parse_schedule_datetime(item["start_time"], "break start_time").isoformat(),
                "end_time": parse_schedule_datetime(item["end_time"], "break end_time").isoformat(),
            }
            for item in breaks
        ]

    def _working_coverage_gaps(
        self,
        assignments: List[Dict[str, Any]],
        demand_windows: List[Dict[str, Any]],
        staff_skills: Dict[str, set[str]],
    ) -> List[Dict[str, Any]]:
        normalized_assignments = []
        for assignment in assignments:
            normalized_assignments.append({
                "staff_id": assignment["staff_id"],
                "start_time": parse_schedule_datetime(assignment["start_time"], "assignment start_time"),
                "end_time": parse_schedule_datetime(assignment["end_time"], "assignment end_time"),
                "breaks": [
                    {
                        "start_time": parse_schedule_datetime(item["start_time"], "break start_time"),
                        "end_time": parse_schedule_datetime(item["end_time"], "break end_time"),
                    }
                    for item in assignment.get("breaks", [])
                ],
            })

        gaps = []
        for window in demand_windows:
            start = window["start_time"]
            end = window["end_time"]
            boundaries = {start, end}
            for assignment in normalized_assignments:
                if assignment["end_time"] <= start or assignment["start_time"] >= end:
                    continue
                boundaries.add(max(start, assignment["start_time"]))
                boundaries.add(min(end, assignment["end_time"]))
                for item in assignment["breaks"]:
                    if item["end_time"] <= start or item["start_time"] >= end:
                        continue
                    boundaries.add(max(start, item["start_time"]))
                    boundaries.add(min(end, item["end_time"]))

            ordered = sorted(boundaries)
            for index in range(len(ordered) - 1):
                segment_start = ordered[index]
                segment_end = ordered[index + 1]
                working = [
                    assignment
                    for assignment in normalized_assignments
                    if assignment["start_time"] <= segment_start
                    and assignment["end_time"] >= segment_end
                    and not any(
                        item["start_time"] < segment_end and item["end_time"] > segment_start
                        for item in assignment["breaks"]
                    )
                ]
                if len(working) < window["required_staff"]:
                    gaps.append({
                        "code": "break_coverage_gap",
                        "date": segment_start.date().isoformat(),
                        "required": window["required_staff"],
                        "available": len(working),
                        "message": "Break placement drops working staff below demand",
                    })
                    break
                for skill, required_count in window.get("skill_requirements", {}).items():
                    qualified = sum(
                        1 for assignment in working if skill in staff_skills.get(assignment["staff_id"], set())
                    )
                    if qualified < required_count:
                        gaps.append({
                            "code": "break_skill_coverage_gap",
                            "date": segment_start.date().isoformat(),
                            "skill": skill,
                            "required": required_count,
                            "available": qualified,
                            "message": "Break placement drops qualified working staff below demand",
                        })
                        break
        return gaps

    def _normalize_staff_skills(
        self,
        staff_skills: Any,
        staff_ids: Iterable[str],
    ) -> Dict[str, set[str]]:
        staff_id_set = set(staff_ids)
        normalized: Dict[str, set[str]] = {staff_id: set() for staff_id in staff_id_set}
        if staff_skills is None:
            return normalized
        if not isinstance(staff_skills, dict):
            raise ValueError("staff_skills must be an object keyed by staff id")

        for staff_id, raw_skills in staff_skills.items():
            if staff_id not in staff_id_set:
                raise ValueError("staff_skills includes a staff id outside staff_ids")
            if not isinstance(raw_skills, list):
                raise ValueError("staff_skills values must be lists")
            if len(raw_skills) > 50:
                raise ValueError("staff_skills cannot exceed 50 skills per staff member")
            normalized[staff_id] = {
                self._normalize_skill_id(skill, "staff_skills")
                for skill in raw_skills
            }
        return normalized

    def _normalize_existing_weekly_minutes(
        self,
        value: Any,
        staff_ids: Iterable[str],
    ) -> Dict[str, Dict[str, int]]:
        staff_id_set = set(staff_ids)
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ValueError("existing_weekly_minutes must be an object keyed by staff id")

        normalized: Dict[str, Dict[str, int]] = {}
        for staff_id, raw_weeks in value.items():
            if staff_id not in staff_id_set:
                raise ValueError("existing_weekly_minutes includes a staff id outside staff_ids")
            if not isinstance(raw_weeks, dict) or len(raw_weeks) > 6:
                raise ValueError("existing_weekly_minutes values must contain at most 6 calendar weeks")
            normalized[staff_id] = {}
            for week_start, raw_minutes in raw_weeks.items():
                try:
                    parsed_week = date.fromisoformat(week_start)
                except (TypeError, ValueError) as exc:
                    raise ValueError("existing_weekly_minutes keys must be ISO Monday dates") from exc
                if parsed_week.weekday() != 0:
                    raise ValueError("existing_weekly_minutes keys must be ISO Monday dates")
                if isinstance(raw_minutes, bool) or not isinstance(raw_minutes, int):
                    raise ValueError("existing_weekly_minutes values must be whole minutes")
                if not 0 <= raw_minutes <= 10_080:
                    raise ValueError("existing_weekly_minutes values must be between 0 and 10080")
                normalized[staff_id][week_start] = raw_minutes
        return normalized

    def _normalize_existing_shift_intervals(
        self,
        value: Any,
        staff_ids: Iterable[str],
        schedule_start: datetime,
        schedule_end: datetime,
    ) -> Dict[str, List[tuple[datetime, datetime]]]:
        if value is None:
            return {}
        if not isinstance(value, list):
            raise ValueError("existing_shift_intervals must be a list")
        if len(value) > 10_000:
            raise ValueError("existing_shift_intervals cannot exceed 10000 entries")
        staff_id_set = set(staff_ids)
        normalized: Dict[str, List[tuple[datetime, datetime]]] = {}
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                raise ValueError("existing shift interval must be an object")
            unknown = set(item) - {"id", "staff_id", "location_id", "start_time", "end_time"}
            if unknown:
                raise ValueError(f"Unsupported existing shift interval field: {sorted(unknown)[0]}")
            staff_id = item.get("staff_id")
            if staff_id not in staff_id_set:
                raise ValueError("existing_shift_intervals includes a staff id outside staff_ids")
            for field in ("id", "location_id"):
                raw = item.get(field)
                if not isinstance(raw, str) or not STAFF_ID_RE.fullmatch(raw):
                    raise ValueError(f"existing_shift_intervals[{index}].{field} is invalid")
            start = parse_schedule_datetime(item.get("start_time"), f"existing_shift_intervals[{index}].start_time")
            end = parse_schedule_datetime(item.get("end_time"), f"existing_shift_intervals[{index}].end_time")
            if end <= start:
                raise ValueError("existing shift interval end_time must be after start_time")
            if start >= schedule_end or end <= schedule_start:
                raise ValueError("existing shift interval must overlap the schedule window")
            normalized.setdefault(staff_id, []).append((start, end))
        return normalized

    def _has_existing_shift_overlap(
        self,
        intervals: Dict[str, List[tuple[datetime, datetime]]],
        staff_id: str,
        start: datetime,
        end: datetime,
    ) -> bool:
        return any(existing_start < end and existing_end > start for existing_start, existing_end in intervals.get(staff_id, []))

    def _calendar_weeks(
        self,
        start: datetime,
        end: datetime,
        schedule_time_zone: ZoneInfo,
    ) -> List[tuple[str, datetime, datetime]]:
        first_local_date = start.astimezone(schedule_time_zone).date()
        week_date = first_local_date - timedelta(days=first_local_date.weekday())
        weeks = []
        while True:
            local_start = datetime.combine(week_date, time.min, tzinfo=schedule_time_zone)
            local_end = datetime.combine(week_date + timedelta(days=7), time.min, tzinfo=schedule_time_zone)
            week_start = local_start.astimezone(timezone.utc)
            week_end = local_end.astimezone(timezone.utc)
            if week_start >= end:
                break
            weeks.append((week_date.isoformat(), week_start, week_end))
            week_date += timedelta(days=7)
        return weeks

    def _overlap_minutes(
        self,
        range_start: datetime,
        range_end: datetime,
        boundary_start: datetime,
        boundary_end: datetime,
    ) -> int:
        overlap_start = max(range_start.astimezone(timezone.utc), boundary_start.astimezone(timezone.utc))
        overlap_end = min(range_end.astimezone(timezone.utc), boundary_end.astimezone(timezone.utc))
        return max(0, int(round((overlap_end - overlap_start).total_seconds() / 60)))

    def _normalize_skill_requirements(self, requirements: Any) -> Dict[str, Dict[str, int]]:
        if requirements is None:
            return {}
        if not isinstance(requirements, dict):
            raise ValueError("skill_requirements must be an object")
        if not requirements:
            return {}

        if all(not isinstance(value, dict) for value in requirements.values()):
            return {"*": self._normalize_skill_counts(requirements, "skill_requirements")}

        normalized: Dict[str, Dict[str, int]] = {}
        for bucket, raw_counts in requirements.items():
            if not isinstance(raw_counts, dict):
                raise ValueError("skill_requirements bucket values must be objects")
            normalized[self._normalize_requirement_bucket(bucket)] = self._normalize_skill_counts(
                raw_counts,
                "skill_requirements",
            )
        return normalized

    def _normalize_skill_counts(self, raw_counts: Dict[str, Any], field: str) -> Dict[str, int]:
        if len(raw_counts) > 25:
            raise ValueError(f"{field} cannot exceed 25 skills per demand bucket")
        normalized: Dict[str, int] = {}
        for raw_skill, raw_count in raw_counts.items():
            skill = self._normalize_skill_id(raw_skill, field)
            normalized[skill] = self._parse_positive_int(raw_count, field)
        return normalized

    def _normalize_skill_id(self, value: Any, field: str) -> str:
        if not isinstance(value, str):
            raise ValueError(f"{field} skills must be strings")
        skill = re.sub(r"\s+", " ", value.strip()).lower()
        if not skill or len(skill) > 64:
            raise ValueError(f"{field} contains an invalid skill")
        return skill

    def _parse_positive_int(self, value: Any, field: str) -> int:
        if isinstance(value, bool):
            raise ValueError(f"{field} counts must be positive integers")
        try:
            parsed = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{field} counts must be positive integers") from exc
        if parsed < 1:
            raise ValueError(f"{field} counts must be positive integers")
        if parsed > MAX_STAFF_IDS:
            raise ValueError(f"{field} counts cannot exceed {MAX_STAFF_IDS}")
        return parsed

    def _normalize_requirement_bucket(self, value: Any) -> str:
        if isinstance(value, str):
            key = value.strip().lower()
            if key in {"*", "all", "default"}:
                return "*"
            if key in DAY_INDEX:
                return f"weekday:{DAY_INDEX[key]}"
            try:
                return f"date:{parse_schedule_datetime(key, 'demand date').date().isoformat()}"
            except ValueError:
                pass
        raise ValueError("demand buckets must be '*', weekday names, or ISO dates")

    def _coverage_for_day(self, daily_demand: Dict[str, int], current_date: datetime, default: int) -> int:
        return max(
            daily_demand.get("*", default),
            daily_demand.get(f"weekday:{current_date.weekday()}", default),
            daily_demand.get(f"date:{current_date.date().isoformat()}", default),
        )

    def _skill_requirements_for_day(
        self,
        requirements: Dict[str, Dict[str, int]],
        current_date: datetime,
    ) -> Dict[str, int]:
        merged: Dict[str, int] = {}
        for bucket in ("*", f"weekday:{current_date.weekday()}", f"date:{current_date.date().isoformat()}"):
            for skill, count in requirements.get(bucket, {}).items():
                merged[skill] = max(merged.get(skill, 0), count)
        return merged

    def _precheck_demand_requirements(
        self,
        staff_ids: List[str],
        start: datetime,
        num_days: int,
        min_coverage: int,
        daily_demand: Dict[str, int],
        staff_skills: Dict[str, set[str]],
        skill_requirements: Dict[str, Dict[str, int]],
        availability: Optional[Dict[str, List[Dict[str, Any]]]],
        shift_duration_hours: float,
        break_calculator: BreakCalculator,
    ) -> List[Dict[str, Any]]:
        details: List[Dict[str, Any]] = []
        for day_index in range(num_days):
            current_date = start + timedelta(days=day_index)
            shift_start = current_date.replace(hour=9, minute=0, second=0, microsecond=0)
            shift_end = shift_start + timedelta(hours=shift_duration_hours)
            available_staff = [
                staff_id
                for staff_id in staff_ids
                if availability is None or self._is_available(availability, staff_id, current_date, shift_start, shift_end)
            ]
            relief = 1 if break_calculator.requires_relief(shift_start, shift_end) else 0
            coverage_required = self._coverage_for_day(daily_demand, current_date, min_coverage)
            if coverage_required + relief > len(available_staff):
                details.append({
                    "code": "coverage_demand_unstaffed",
                    "date": current_date.date().isoformat(),
                    "required": coverage_required + relief,
                    "available": len(available_staff),
                    "message": "Floor coverage demand exceeds available staff for this day",
                })

            for skill, required_count in self._skill_requirements_for_day(skill_requirements, current_date).items():
                available_with_skill = [
                    staff_id
                    for staff_id in available_staff
                    if skill in staff_skills.get(staff_id, set())
                ]
                if required_count + relief > len(available_with_skill):
                    details.append({
                        "code": "skill_demand_unstaffed",
                        "date": current_date.date().isoformat(),
                        "skill": skill,
                        "required": required_count + relief,
                        "available": len(available_with_skill),
                        "message": "Skill demand exceeds available qualified staff for this day",
                    })
            if len(details) >= 20:
                break
        return details

    def _normalize_availability(
        self,
        availability: Optional[Any],
        staff_ids: Iterable[str],
    ) -> Optional[Dict[str, List[Dict[str, Any]]]]:
        if availability is None:
            return None
        if not isinstance(availability, dict):
            raise ValueError("availability must be an object keyed by staff id")

        staff_id_set = set(staff_ids)
        normalized: Dict[str, List[Dict[str, Any]]] = {}
        for staff_id, rules in availability.items():
            if staff_id not in staff_id_set:
                raise ValueError("availability includes a staff id outside staff_ids")
            if not isinstance(rules, list):
                raise ValueError("availability rules must be lists")
            if len(rules) > 21:
                raise ValueError("availability cannot exceed 21 rules per staff member")
            normalized[staff_id] = []
            for rule in rules:
                if not isinstance(rule, dict):
                    raise ValueError("availability rule must be an object")
                normalized[staff_id].append({
                    "day_of_week": self._parse_day(rule.get("day_of_week")),
                    "start_minute": self._parse_time(rule.get("start_time", "00:00")),
                    "end_minute": self._parse_time(rule.get("end_time", "23:59")),
                })
                if normalized[staff_id][-1]["start_minute"] == normalized[staff_id][-1]["end_minute"]:
                    raise ValueError("availability start_time and end_time cannot be equal")
        return normalized

    def _parse_day(self, value: Any) -> int:
        if isinstance(value, int) and 0 <= value <= 6:
            return value
        if isinstance(value, str):
            key = value.strip().lower()
            if key.isdigit() and 0 <= int(key) <= 6:
                return int(key)
            if key in DAY_INDEX:
                return DAY_INDEX[key]
        raise ValueError("availability day_of_week must be 0-6 or a weekday name")

    def _parse_time(self, value: Any) -> int:
        if not isinstance(value, str):
            raise ValueError("availability times must be strings")
        parts = value.strip().split(":")
        if len(parts) not in {2, 3}:
            raise ValueError("availability times must be HH:MM")
        try:
            hour = int(parts[0])
            minute = int(parts[1])
        except ValueError as exc:
            raise ValueError("availability times must be numeric") from exc
        if hour < 0 or hour > 23 or minute < 0 or minute > 59:
            raise ValueError("availability times must be valid 24-hour times")
        return hour * 60 + minute

    def _is_available(
        self,
        availability: Dict[str, List[Dict[str, Any]]],
        staff_id: str,
        current_date: datetime,
        shift_start: datetime,
        shift_end: datetime,
    ) -> bool:
        rules = availability.get(staff_id, [])
        if staff_id not in availability:
            return True
        if not rules:
            return False
        del current_date
        for weekday, start_minute, end_minute in self._availability_segments(shift_start, shift_end):
            if not any(self._availability_rule_covers(rule, weekday, start_minute, end_minute) for rule in rules):
                return False
        return True

    def _availability_segments(
        self,
        shift_start: datetime,
        shift_end: datetime,
    ) -> Iterable[tuple[int, int, int]]:
        cursor = shift_start
        while cursor < shift_end:
            next_midnight = datetime.combine(cursor.date() + timedelta(days=1), time.min, tzinfo=cursor.tzinfo)
            segment_end = min(shift_end, next_midnight)
            yield (
                cursor.weekday(),
                cursor.hour * 60 + cursor.minute,
                1440 if segment_end == next_midnight else segment_end.hour * 60 + segment_end.minute,
            )
            cursor = segment_end

    def _availability_rule_covers(
        self,
        rule: Dict[str, Any],
        weekday: int,
        start_minute: int,
        end_minute: int,
    ) -> bool:
        rule_day = rule["day_of_week"]
        rule_start = rule["start_minute"]
        rule_end = rule["end_minute"]
        if rule_end > rule_start:
            return rule_day == weekday and rule_start <= start_minute and rule_end >= end_minute
        if rule_day == weekday:
            return rule_start <= start_minute and end_minute <= 1440
        return (rule_day + 1) % 7 == weekday and start_minute >= 0 and rule_end >= end_minute
