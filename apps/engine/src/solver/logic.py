"""
Core Scheduling Solver and Break Calculator.
Architecture Part VIII — constraint-based scheduling optimization.
"""

from typing import List, Dict, Any, Optional
from datetime import datetime, timedelta
import logging

logger = logging.getLogger("engine.solver")


class BreakCalculator:
    """
    Calculate mandatory breaks based on labor law compliance.
    Rules are configurable via tenant settings.
    """

    DEFAULT_RULES = {
        "min_shift_for_break": 5.0,      # hours before a break is required
        "break_duration": 30,            # minutes
        "min_shift_for_second_break": 10.0,
        "second_break_duration": 30,
        "paid_break_threshold": 20,      # minutes — breaks under this are paid
    }

    def __init__(self, rules: Optional[Dict] = None):
        self.rules = {**self.DEFAULT_RULES, **(rules or {})}

    def calculate_breaks(self, start_time: datetime, end_time: datetime) -> List[Dict]:
        """Calculate required breaks for a shift."""
        duration_hours = (end_time - start_time).total_seconds() / 3600
        breaks = []

        if duration_hours >= self.rules["min_shift_for_break"]:
            # First break at the midpoint of the first half
            midpoint = start_time + (end_time - start_time) / 3
            break_end = midpoint + timedelta(minutes=self.rules["break_duration"])
            breaks.append({
                "start_time": midpoint.isoformat(),
                "end_time": break_end.isoformat(),
                "duration_minutes": self.rules["break_duration"],
                "paid": self.rules["break_duration"] <= self.rules["paid_break_threshold"],
                "type": "meal",
            })

        if duration_hours >= self.rules["min_shift_for_second_break"]:
            # Second break at the 2/3 point
            second_point = start_time + (end_time - start_time) * 2 / 3
            break_end = second_point + timedelta(minutes=self.rules["second_break_duration"])
            breaks.append({
                "start_time": second_point.isoformat(),
                "end_time": break_end.isoformat(),
                "duration_minutes": self.rules["second_break_duration"],
                "paid": self.rules["second_break_duration"] <= self.rules["paid_break_threshold"],
                "type": "meal",
            })

        return breaks


class ConstraintSolver:
    """
    Constraint-based scheduling solver utilizing Google OR-Tools CP-SAT.
    Architecture Part VIII — robust, constraint-programmed optimization.
    """

    def __init__(self, config: Optional[Dict] = None):
        self.config = config or {}
        self.break_calculator = BreakCalculator(config.get("break_rules") if config else None)

    def solve(
        self,
        staff_ids: List[str],
        start_date: str,
        end_date: str,
        constraints: Dict[str, Any] = {},
    ) -> Dict[str, Any]:
        from ortools.sat.python import cp_model

        if not staff_ids:
            return {"assignments": [], "score": 0.0, "feasible": False, "reason": "No staff available"}

        try:
            start = datetime.fromisoformat(start_date)
            end = datetime.fromisoformat(end_date)
            num_days = (end - start).days
            if num_days <= 0:
                raise ValueError("End date must be after start date")
        except ValueError as e:
            return {"assignments": [], "score": 0.0, "feasible": False, "reason": str(e)}

        min_coverage = constraints.get("min_floor_coverage", 1)
        shift_duration_hours = constraints.get("shift_duration_hours", 8)
        max_hours_per_week = constraints.get("max_hours_per_week", 40)
        max_shifts_per_week = max_hours_per_week // shift_duration_hours

        model = cp_model.CpModel()

        # variables[s, d] == 1 if staff s is assigned on day d
        shifts = {}
        for s in staff_ids:
            for d in range(num_days):
                shifts[(s, d)] = model.NewBoolVar(f"shift_n{s}_d{d}")

        # Constraint 1: Minimum daily coverage
        for d in range(num_days):
            model.Add(sum(shifts[(s, d)] for s in staff_ids) >= min_coverage)

        # Constraint 2: Max hours/shifts per week
        # Assuming schedule is <= 7 days for this simple window
        if num_days <= 7:
            for s in staff_ids:
                model.Add(sum(shifts[(s, d)] for d in range(num_days)) <= max_shifts_per_week)

        # Objective: Distribute shifts fairly (minimize max shifts by any single worker)
        max_shifts = model.NewIntVar(0, num_days, "max_shifts")
        for s in staff_ids:
            model.Add(sum(shifts[(s, d)] for d in range(num_days)) <= max_shifts)
        model.Minimize(max_shifts)

        solver = cp_model.CpSolver()
        # Optional: Set time limit via rules
        solver.parameters.max_time_in_seconds = 10.0
        status = solver.Solve(model)

        assignments = []
        staff_hours: Dict[str, float] = {sid: 0.0 for sid in staff_ids}

        if status == cp_model.OPTIMAL or status == cp_model.FEASIBLE:
            for d in range(num_days):
                current_date = start + timedelta(days=d)
                for s in staff_ids:
                    if solver.Value(shifts[(s, d)]) == 1:
                        shift_start = current_date.replace(hour=9, minute=0)
                        shift_end = shift_start + timedelta(hours=shift_duration_hours)
                        breaks = self.break_calculator.calculate_breaks(shift_start, shift_end)
                        
                        assignments.append({
                            "staff_id": s,
                            "date": current_date.date().isoformat(),
                            "start_time": shift_start.isoformat(),
                            "end_time": shift_end.isoformat(),
                            "breaks": breaks,
                        })
                        staff_hours[s] += shift_duration_hours

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
        else:
            return {"assignments": [], "score": 0.0, "feasible": False, "reason": "No feasible solution found under constraints"}
