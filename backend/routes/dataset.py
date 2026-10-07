"""
Dataset management and ingestion pipeline.

Supports:
- CSV & Excel file uploads (.csv, .xlsx, .xls)
- Data validation, duplicate detection, missing-value imputation
- Origin labeling: 'synthetic', 'imported', 'measured'
- Summary metrics and CSV template generator
- Clearly labeled simulated sensor stream
"""
from __future__ import annotations

import io
import re
from datetime import date, datetime
from typing import Optional

import pandas as pd
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Building, Occupancy, Room

router = APIRouter(prefix="/api/dataset", tags=["dataset"])

# Recognized column aliases
ALIAS_MAP = {
    "date": ["date", "day", "record_date", "dt"],
    "timestamp": ["timestamp", "datetime", "time_stamp", "ts"],
    "hour": ["hour", "hr", "time_hour", "slot"],
    "room": ["room", "room_code", "room_name", "room_id", "location"],
    "building": ["building", "building_code", "bldg", "block"],
    "occupancy": ["occupancy", "occupancy_count", "occupants", "count", "headcount", "people", "actual_occupancy"],
    "capacity": ["capacity", "max_capacity", "room_capacity", "seats"],
    "room_type": ["room_type", "type", "roomtype", "category"],
    "floor": ["floor", "floor_level", "level"],
    "students_count": ["students", "students_count", "student_count"],
    "staff_count": ["staff", "staff_count", "faculty", "instructors"],
    "is_exam": ["is_exam", "exam", "examination"],
    "scheduled_class": ["scheduled_class", "course", "class_name", "subject"],
}


def _match_column(df_cols: list[str], target_field: str) -> Optional[str]:
    aliases = ALIAS_MAP.get(target_field, [target_field])
    lower_cols = {c.strip().lower(): c for c in df_cols}
    for alias in aliases:
        if alias in lower_cols:
            return lower_cols[alias]
    return None


@router.post("/upload")
async def upload_dataset(
    file: UploadFile = File(...),
    origin: str = Form("imported"),  # 'imported' | 'measured' | 'synthetic'
    replace_duplicates: bool = Form(True),
    db: Session = Depends(get_db),
):
    """
    Ingest occupancy dataset from CSV or Excel file.
    Performs data cleaning, validation, and tags the data origin clearly.
    """
    filename = file.filename or "uploaded_data"
    contents = await file.read()
    if len(contents) == 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    if len(contents) > 15 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 15MB).")

    # Read dataframe
    try:
        if filename.endswith((".xlsx", ".xls")):
            df = pd.read_excel(io.BytesIO(contents))
        else:
            df = pd.read_csv(io.BytesIO(contents))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to parse file: {str(e)}")

    if df.empty:
        raise HTTPException(status_code=400, detail="Dataset has no records.")

    cols = list(df.columns)
    c_date = _match_column(cols, "date")
    c_ts = _match_column(cols, "timestamp")
    c_hour = _match_column(cols, "hour")
    c_room = _match_column(cols, "room")
    c_occ = _match_column(cols, "occupancy")
    c_bldg = _match_column(cols, "building")
    c_cap = _match_column(cols, "capacity")
    c_type = _match_column(cols, "room_type")
    c_floor = _match_column(cols, "floor")
    c_stud = _match_column(cols, "students_count")
    c_staff = _match_column(cols, "staff_count")
    c_exam = _match_column(cols, "is_exam")
    c_class = _match_column(cols, "scheduled_class")

    if not c_room:
        raise HTTPException(status_code=422, detail="Missing room identifier column ('room' or 'room_code').")
    if not c_occ:
        raise HTTPException(status_code=422, detail="Missing occupancy count column ('occupancy' or 'count').")
    if not c_date and not c_ts:
        raise HTTPException(status_code=422, detail="Missing date or timestamp column ('date' or 'timestamp').")

    # Fetch existing rooms & buildings
    buildings_by_code = {b.code: b for b in db.query(Building).all()}
    rooms_by_code = {r.code: r for r in db.query(Room).all()}

    # Ensure default building if needed
    default_building = db.query(Building).first()
    if not default_building:
        default_building = Building(code="GEN", name="General Campus", x=50, y=50)
        db.add(default_building)
        db.commit()
        db.refresh(default_building)
        buildings_by_code["GEN"] = default_building

    inserted = 0
    updated = 0
    skipped = 0
    errors = []
    warnings = []

    # Map existing occupancy keys for fast lookup: (room_id, date, hour) -> id
    existing_records = {
        (o.room_id, o.date, o.hour): o.id
        for o in db.query(Occupancy.room_id, Occupancy.date, Occupancy.hour, Occupancy.id).all()
    }

    new_objects = []

    for idx, row in df.iterrows():
        row_num = idx + 2  # 1-indexed header offset

        # Parse Room
        room_val = str(row[c_room]).strip()
        if not room_val or room_val.lower() in ("nan", "none", ""):
            errors.append(f"Row {row_num}: Missing room code.")
            skipped += 1
            continue

        room_obj = rooms_by_code.get(room_val)
        if not room_obj:
            # Auto-create room if capacity is provided or default
            bldg_code = str(row[c_bldg]).strip() if c_bldg and pd.notna(row[c_bldg]) else (room_val.split("-")[0] if "-" in room_val else "GEN")
            bldg_obj = buildings_by_code.get(bldg_code)
            if not bldg_obj:
                bldg_obj = Building(code=bldg_code, name=f"Building {bldg_code}", x=50, y=50)
                db.add(bldg_obj)
                db.commit()
                db.refresh(bldg_obj)
                buildings_by_code[bldg_code] = bldg_obj

            cap_val = int(row[c_cap]) if c_cap and pd.notna(row[c_cap]) and int(row[c_cap]) > 0 else 50
            rtype_val = str(row[c_type]).strip() if c_type and pd.notna(row[c_type]) else "classroom"
            floor_val = int(row[c_floor]) if c_floor and pd.notna(row[c_floor]) else 1

            room_obj = Room(code=room_val, building_id=bldg_obj.id, room_type=rtype_val, capacity=cap_val, floor=floor_val)
            db.add(room_obj)
            db.commit()
            db.refresh(room_obj)
            rooms_by_code[room_val] = room_obj

        # Parse Date & Hour
        parsed_date: Optional[str] = None
        parsed_hour: Optional[int] = None

        if c_ts and pd.notna(row[c_ts]):
            try:
                dt_val = pd.to_datetime(row[c_ts])
                parsed_date = dt_val.strftime("%Y-%m-%d")
                parsed_hour = dt_val.hour
            except Exception:
                pass

        if not parsed_date and c_date and pd.notna(row[c_date]):
            try:
                dt_val = pd.to_datetime(row[c_date])
                parsed_date = dt_val.strftime("%Y-%m-%d")
                if parsed_hour is None and c_hour and pd.notna(row[c_hour]):
                    parsed_hour = int(row[c_hour])
            except Exception:
                pass

        if parsed_hour is None and c_hour and pd.notna(row[c_hour]):
            try:
                parsed_hour = int(row[c_hour])
            except Exception:
                pass

        if not parsed_date or parsed_hour is None:
            errors.append(f"Row {row_num}: Invalid date or hour format.")
            skipped += 1
            continue

        if not (0 <= parsed_hour <= 23):
            errors.append(f"Row {row_num}: Hour {parsed_hour} out of 0-23 range.")
            skipped += 1
            continue

        # Parse Occupancy count
        try:
            occ_count = int(round(float(row[c_occ])))
            if occ_count < 0:
                errors.append(f"Row {row_num}: Negative occupancy count ({occ_count}) not allowed.")
                skipped += 1
                continue
        except (ValueError, TypeError):
            errors.append(f"Row {row_num}: Invalid occupancy value '{row[c_occ]}'.")
            skipped += 1
            continue

        if room_obj.capacity and occ_count > room_obj.capacity:
            warnings.append(f"Row {row_num}: Room {room_obj.code} occupancy ({occ_count}) exceeds capacity ({room_obj.capacity}).")

        # Parse extra fields
        stud_count = int(row[c_stud]) if c_stud and pd.notna(row[c_stud]) else None
        staff_cnt = int(row[c_staff]) if c_staff and pd.notna(row[c_staff]) else None
        is_ex = int(bool(row[c_exam])) if c_exam and pd.notna(row[c_exam]) else 0
        sched_cls = str(row[c_class]).strip() if c_class and pd.notna(row[c_class]) else None

        key = (room_obj.id, parsed_date, parsed_hour)
        if key in existing_records:
            if replace_duplicates:
                existing_id = existing_records[key]
                record = db.query(Occupancy).filter(Occupancy.id == existing_id).first()
                if record:
                    record.occupancy_count = occ_count
                    record.data_origin = origin
                    record.students_count = stud_count
                    record.staff_count = staff_cnt
                    record.is_exam = is_ex
                    record.scheduled_class = sched_cls
                    updated += 1
            else:
                skipped += 1
        else:
            new_objects.append(
                Occupancy(
                    room_id=room_obj.id,
                    date=parsed_date,
                    hour=parsed_hour,
                    occupancy_count=occ_count,
                    data_origin=origin,
                    students_count=stud_count,
                    staff_count=staff_cnt,
                    is_exam=is_ex,
                    scheduled_class=sched_cls,
                )
            )
            existing_records[key] = -1
            inserted += 1

    if new_objects:
        db.bulk_save_objects(new_objects)
    db.commit()

    return {
        "status": "success",
        "filename": filename,
        "data_origin": origin,
        "total_rows": len(df),
        "inserted": inserted,
        "updated": updated,
        "skipped": skipped,
        "warnings_count": len(warnings),
        "errors_count": len(errors),
        "sample_warnings": warnings[:10],
        "sample_errors": errors[:10],
        "message": f"Successfully processed {len(df)} rows ({inserted} inserted, {updated} updated, {skipped} skipped). Data origin: {origin}.",
    }


@router.get("/summary")
def dataset_summary(db: Session = Depends(get_db)):
    """Summary metrics of all records in the database, broken down by origin."""
    total_records = db.query(func.count(Occupancy.id)).scalar() or 0
    origin_counts = dict(
        db.query(Occupancy.data_origin, func.count(Occupancy.id))
        .group_by(Occupancy.data_origin)
        .all()
    )
    date_min = db.query(func.min(Occupancy.date)).scalar()
    date_max = db.query(func.max(Occupancy.date)).scalar()
    room_count = db.query(func.count(Room.id)).scalar() or 0
    building_count = db.query(func.count(Building.id)).scalar() or 0

    return {
        "total_records": total_records,
        "origins": {
            "synthetic": origin_counts.get("synthetic", 0),
            "imported": origin_counts.get("imported", 0),
            "measured": origin_counts.get("measured", 0),
        },
        "coverage": {
            "start_date": date_min,
            "end_date": date_max,
            "buildings": building_count,
            "rooms": room_count,
        },
        "description": "Historical records stored in database. Synthetic records are tagged as demonstration data; uploaded records are tagged as imported.",
    }


@router.get("/preview")
def dataset_preview(
    limit: int = Query(50, ge=1, le=200),
    origin: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """Retrieve sample rows from the occupancy database with origin markers."""
    q = (
        db.query(
            Occupancy.id,
            Occupancy.date,
            Occupancy.hour,
            Occupancy.occupancy_count,
            Occupancy.data_origin,
            Occupancy.students_count,
            Occupancy.staff_count,
            Occupancy.scheduled_class,
            Room.code.label("room"),
            Room.room_type,
            Room.capacity,
            Building.code.label("building"),
            Building.name.label("building_name"),
        )
        .join(Room, Occupancy.room_id == Room.id)
        .join(Building, Room.building_id == Building.id)
    )
    if origin:
        q = q.filter(Occupancy.data_origin == origin)
    rows = q.order_by(Occupancy.date.desc(), Occupancy.hour.desc()).limit(limit).all()

    return [
        {
            "id": r.id,
            "date": r.date,
            "hour": r.hour,
            "occupancy": r.occupancy_count,
            "data_origin": r.data_origin,
            "students": r.students_count,
            "staff": r.staff_count,
            "scheduled_class": r.scheduled_class,
            "room": r.room,
            "type": r.room_type,
            "capacity": r.capacity,
            "utilization": round(r.occupancy_count / r.capacity * 100, 1) if r.capacity else 0,
            "building": r.building,
            "building_name": r.building_name,
        }
        for r in rows
    ]


@router.get("/template")
def download_template():
    """Generates a downloadable CSV template with standard columns and documentation."""
    csv_content = (
        "date,hour,room,occupancy,capacity,room_type,students_count,staff_count,scheduled_class,is_exam\n"
        "2026-09-24,09,A-101,42,60,classroom,40,2,CS101,0\n"
        "2026-09-24,10,A-102,55,60,classroom,53,2,CS201,0\n"
        "2026-09-24,11,A-Lab1,28,30,lab,26,2,DSLab,0\n"
        "2026-09-24,12,B-Ref,180,500,library,175,5,Study,0\n"
        "2026-09-24,13,C-FoodCourt,210,350,cafeteria,200,10,Lunch,0\n"
    )
    return Response(
        content=csv_content,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=campus_occupancy_template.csv"},
    )


@router.post("/simulate-stream")
def simulate_live_sensor_stream(
    room_code: str = Query("A-101"),
    occupancy_count: int = Query(35, ge=0),
    db: Session = Depends(get_db),
):
    """
    Demonstration / simulation endpoint for IoT sensor or turnstile integration.
    Clearly labeled as simulated demonstration data.
    """
    clean_code = room_code.strip()
    room = db.query(Room).filter(func.lower(Room.code) == clean_code.lower()).first()
    if not room:
        # Also try matching with a hyphen if missing (e.g. A101 -> A-101)
        m = re.match(r"^([a-zA-Z]+)(\d+.*)$", clean_code)
        if m:
            hyphen_code = f"{m.group(1)}-{m.group(2)}".lower()
            room = db.query(Room).filter(func.lower(Room.code) == hyphen_code).first()
    if not room:
        raise HTTPException(status_code=404, detail=f"Room '{room_code}' not found.")

    now = datetime.now()
    today_s = now.strftime("%Y-%m-%d")
    current_hour = now.hour

    # Record or update simulated observation
    rec = (
        db.query(Occupancy)
        .filter(Occupancy.room_id == room.id, Occupancy.date == today_s, Occupancy.hour == current_hour)
        .first()
    )
    if rec:
        rec.occupancy_count = occupancy_count
        rec.data_origin = "measured"
    else:
        rec = Occupancy(
            room_id=room.id,
            date=today_s,
            hour=current_hour,
            occupancy_count=occupancy_count,
            data_origin="measured",
        )
        db.add(rec)
    db.commit()

    return {
        "status": "stream_received",
        "mode": "Simulated Live Sensor Stream (Demonstration)",
        "room": room.code,
        "date": today_s,
        "hour": current_hour,
        "recorded_occupancy": occupancy_count,
        "capacity": room.capacity,
        "data_origin": "measured",
        "note": "This is an explicit simulation mode; no real IoT hardware is claimed.",
    }


@router.post("/generate-synthetic")
def generate_synthetic_dataset_endpoint(
    start_date: str = Query("2026-09-01"),
    end_date: str = Query("2026-09-24"),
    scenario: str = Query("normal"),  # normal, exam, fest, vacation
    noise_level: float = Query(0.08, ge=0.0, le=0.5),
    seed_db: bool = Query(True),
    db: Session = Depends(get_db),
):
    """
    Generate realistic synthetic occupancy records with diurnal curves, academic schedules,
    and student/staff breakdown. Can optionally seed directly into SQLite database.
    """
    from ..services.synthetic_generator import generate_synthetic_records

    try:
        s_date = datetime.strptime(start_date, "%Y-%m-%d").date()
        e_date = datetime.strptime(end_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Expected YYYY-MM-DD.")

    if s_date > e_date:
        raise HTTPException(status_code=400, detail="start_date must be before or equal to end_date.")

    if (e_date - s_date).days > 365:
        raise HTTPException(status_code=400, detail="Maximum generation span is 365 days.")

    rooms = db.query(Room).all()
    if not rooms:
        raise HTTPException(status_code=400, detail="No rooms configured in database.")

    room_dicts = [
        {"id": r.id, "code": r.code, "room_type": r.room_type, "capacity": r.capacity}
        for r in rooms
    ]

    records = generate_synthetic_records(
        rooms=room_dicts,
        start_date=s_date,
        end_date=e_date,
        scenario=scenario,
        noise_level=noise_level,
    )

    if seed_db and records:
        # Fast bulk upsert / insert
        # Delete existing synthetic records in this range to avoid duplicates
        existing_q = db.query(Occupancy).filter(
            Occupancy.date >= start_date,
            Occupancy.date <= end_date,
            Occupancy.data_origin == "synthetic",
        )
        deleted_count = existing_q.delete(synchronize_session=False)

        # Bulk insert
        to_insert = [
            {
                "room_id": rec["room_id"],
                "date": rec["date"],
                "hour": rec["hour"],
                "occupancy_count": rec["occupancy_count"],
                "students_count": rec["students_count"],
                "staff_count": rec["staff_count"],
                "scheduled_class": rec["scheduled_class"],
                "is_exam": rec["is_exam"],
                "data_origin": "synthetic",
            }
            for rec in records
        ]

        # Insert in chunks of 2000
        for i in range(0, len(to_insert), 2000):
            db.bulk_insert_mappings(Occupancy, to_insert[i:i+2000])
        db.commit()

    return {
        "status": "success",
        "message": f"Successfully generated {len(records):,} synthetic records.",
        "start_date": start_date,
        "end_date": end_date,
        "scenario": scenario,
        "records_count": len(records),
        "rooms_covered": len(rooms),
        "seeded_to_db": seed_db,
        "data_origin": "synthetic",
    }


@router.get("/download-synthetic")
def download_synthetic_dataset_csv(
    start_date: str = Query("2026-09-01"),
    end_date: str = Query("2026-09-24"),
    scenario: str = Query("normal"),
    noise_level: float = Query(0.08, ge=0.0, le=0.5),
    db: Session = Depends(get_db),
):
    """Generates and directly streams a synthetic dataset CSV file for download."""
    from ..services.synthetic_generator import generate_synthetic_records

    try:
        s_date = datetime.strptime(start_date, "%Y-%m-%d").date()
        e_date = datetime.strptime(end_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Expected YYYY-MM-DD.")

    rooms = db.query(Room).all()
    room_dicts = [
        {"id": r.id, "code": r.code, "room_type": r.room_type, "capacity": r.capacity}
        for r in rooms
    ]

    records = generate_synthetic_records(
        rooms=room_dicts,
        start_date=s_date,
        end_date=e_date,
        scenario=scenario,
        noise_level=noise_level,
    )

    df = pd.DataFrame(records)
    # Reorder columns cleanly
    cols_order = ["date", "hour", "room_code", "occupancy_count", "students_count", "staff_count", "scheduled_class", "is_exam", "data_origin"]
    df = df[[c for c in cols_order if c in df.columns]]
    df.rename(columns={"room_code": "room", "occupancy_count": "occupancy"}, inplace=True)

    csv_buffer = io.StringIO()
    df.to_csv(csv_buffer, index=False)
    csv_bytes = csv_buffer.getvalue().encode("utf-8")

    return Response(
        content=csv_bytes,
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=synthetic_occupancy_{scenario}_{start_date}_to_{end_date}.csv"},
    )

