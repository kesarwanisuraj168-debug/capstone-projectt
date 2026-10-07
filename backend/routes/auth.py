"""Authentication routes: admin login, admin me, disabled public register."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import require_admin
from ..models import User
from ..schemas import LoginRequest, LoginResponse, UserOut
from ..security import create_token, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register")
def register():
    """Public registration is disabled in the admin-only system."""
    raise HTTPException(
        status_code=403,
        detail="Public user registration is disabled. Administrator access only."
    )


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    """Authenticate authorized administrator accounts only."""
    user = db.query(User).filter(User.username == body.username).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    if user.role != "admin":
        raise HTTPException(
            status_code=403,
            detail="Access denied. Administrator privileges required."
        )
    token = create_token(user.id, user.username, user.role)
    return LoginResponse(token=token, user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(require_admin)):
    """Return currently authenticated administrator profile."""
    return user

