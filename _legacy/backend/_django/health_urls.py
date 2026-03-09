from django.urls import path

from . import health_views

urlpatterns = [
    path("", health_views.health, name="health"),
    path("live/", health_views.liveness, name="health-live"),
    path("ready/", health_views.readiness, name="health-ready"),
    path("gate/", health_views.site_gate, name="site-gate"),
]
