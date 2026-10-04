"""Aggregated dashboard endpoint (KPIs + chart series)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config import HOURS
from ..database import get_db
from ..models import Building, Occupancy, Room
from ..services import forecasting

router = APIRouter(prefix="/api", tags=["dashboard"])


def _actual_for(db: Session, dt: str, hour: int) -> dict:
    rows = (
        db.query(Building.code, func.sum(Occupancy.occupancy_count))
        .join(Room, Room.building_id == Building.id)
        .join(Occupancy, Occupancy.room_id == Room.id)
        .filter(Occupancy.date == dt, Occupancy.hour == hour)
        .group_by(Building.code).order_by(Building.code).all()
    )
    return {c: int(v) for c, v in rows}


@router.get("/dashboard")
def dashboard(dt: str | None = Query(None, alias="date"), hour: int | None = Query(None),
              db: Session = Depends(get_db)):
    # Find latest date that has campus-wide historical records (at least 20 rooms)
    latest_full = (
        db.query(Occupancy.date)
        .group_by(Occupancy.date)
        .having(func.count(Occupancy.id) >= 20)
        .order_by(Occupancy.date.desc())
        .first()
    )
    latest = latest_full[0] if latest_full else db.query(func.max(Occupancy.date)).scalar()
    if not latest:
        return {"error": "No occupancy data. Run: py -3.11 -m backend.seed"}

    date_s = dt or latest
    hour = hour if hour is not None else 12

    fc = forecasting.campus_forecast(db, date_s, hour)
    actual = _actual_for(db, date_s, hour)

    buildings = []
    for b in fc["buildings"]:
        buildings.append({
            **b,
            "actual": actual.get(b["building"], 0),
        })

    # hourly actual vs predicted for the selected date
    trend = []
    for h in HOURS:
        a = _actual_for(db, date_s, h)
        p = forecasting.campus_forecast(db, date_s, h)
        trend.append({
            "hour": h,
            "actual": sum(a.values()),
            "predicted": p["total_predicted"],
            "capacity": p["total_capacity"],
        })

    peak = max(trend, key=lambda t: t["predicted"])

    # rooms with free seats at the requested hour
    all_rooms = (
        db.query(Room.id, Building.code, Room.code, Room.room_type, Room.capacity)
        .join(Building).order_by(Building.code, Room.code).all()
    )
    free_rooms = []
    for room_id, bcode, rcode, rtype, cap in all_rooms:
        meta = forecasting.ROOMS.get(rcode)
        if not meta:
            continue
        predicted = forecasting.predict_room(db, meta, room_id, date_s, hour)
        if cap - predicted >= 15:  # at least 15 free seats
            free_rooms.append({
                "room": rcode, "building": bcode, "type": rtype,
                "capacity": cap, "predicted": predicted, "free": cap - predicted,
})

    overcapacity = [b for b in buildings if b["utilization"] >= 80]

    try:
        m_meta = forecasting.model_metrics()
    except RuntimeError:
        m_meta = {}

    return {
        "date": date_s,
        "latest_data_date": latest,
        "hour": hour,
        "kpis": {
            "current_occupancy": sum(actual.values()),
            "predicted_occupancy": fc["total_predicted"],
            "capacity": fc["total_capacity"],
            "utilization": fc["utilization"],
            "overcapacity_areas": len(overcapacity),
            "available_rooms": len(free_rooms),
            "peak_hour": peak["hour"],
            "peak_value": peak["predicted"],
        },
"buildings": buildings,
        "trend": trend,
        "free_rooms": free_rooms,
        "model": {
            "name": m_meta.get("model"),
            "metrics": m_meta.get("metrics", {}),
        },
    }

