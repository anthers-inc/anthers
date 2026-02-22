import os

from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "_django.settings")

app = Celery("bluebell")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()
