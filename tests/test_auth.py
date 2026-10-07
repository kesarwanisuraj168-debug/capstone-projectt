import pytest
from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)

def test_login_success():
    resp = client.post("/api/auth/login", json={"username": "admin", "password": "admin123"})
    assert resp.status_code == 200
    data = resp.json()
    assert "token" in data
    assert data["user"]["role"] == "admin"

def test_login_invalid_password():
    resp = client.post("/api/auth/login", json={"username": "admin", "password": "wrongpassword"})
    assert resp.status_code == 401

def test_non_admin_login_rejected():
    resp = client.post("/api/auth/login", json={"username": "user", "password": "user123"})
    assert resp.status_code == 403
    assert "Administrator" in resp.json()["detail"]

def test_user_me_admin():
    login_resp = client.post("/api/auth/login", json={"username": "admin", "password": "admin123"})
    token = login_resp.json()["token"]
    resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json()["username"] == "admin"
    assert resp.json()["role"] == "admin"

def test_user_me_unauthorized():
    resp = client.get("/api/auth/me")
    assert resp.status_code == 401

def test_public_registration_disabled():
    resp = client.post("/api/auth/register", json={"username": "newuser", "password": "password123"})
    assert resp.status_code == 403
