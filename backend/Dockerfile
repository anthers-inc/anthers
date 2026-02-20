# ── Build stage ──
FROM python:3.13-slim AS build
WORKDIR /build
COPY requirements.txt .
RUN pip install --upgrade pip && pip install --user --no-cache-dir -r requirements.txt

# ── Runtime stage ──
FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 DJANGO_SETTINGS_MODULE=_django.settings
WORKDIR /app
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
RUN adduser --disabled-password --force-badname --uid 1000 _django
COPY --from=build --chown=_django:_django /root/.local /home/_django/.local
ENV PATH="/home/_django/.local/bin:$PATH"
COPY --chown=_django:_django . .
USER _django
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["sh", "-c", "gunicorn _django.wsgi:application --bind 0.0.0.0:${BACKEND_PORT} --workers 4"]
