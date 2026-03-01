"""
URL routing for Wiki endpoints.

Registered at /api/v1/wiki/ for public documentation.
"""

from django.urls import path
from . import views

# Wiki URLs (register at /api/v1/wiki/)
wiki_urlpatterns = [
    path("<str:section>/<str:filename>/", views.wiki_content_view, name="wiki-content"),
]
