import json
import os

from django.db import connection
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST


def health(request):
    return JsonResponse({"status": "ok"})


@csrf_exempt
@require_POST
def site_gate(request):
    try:
        data = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return JsonResponse({"ok": False}, status=400)
    expected = os.environ.get("SITE_PASSWORD", "")
    if not expected or data.get("password") != expected:
        return JsonResponse({"ok": False}, status=403)
    return JsonResponse({"ok": True})


def liveness(request):
    return JsonResponse({"status": "alive"})


def readiness(request):
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        db_ok = True
    except Exception:
        db_ok = False

    status = "ready" if db_ok else "not_ready"
    status_code = 200 if db_ok else 503
    return JsonResponse({"status": status, "database": db_ok}, status=status_code)
