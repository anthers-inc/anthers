from django.db import connection
from django.http import JsonResponse


def health(request):
    return JsonResponse({"status": "ok"})


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
