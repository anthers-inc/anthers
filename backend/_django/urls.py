from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView

urlpatterns = [
    path("admin/", admin.site.urls),
    path("health/", include("_django.health_urls")),
    path("api/v1/", include([
        path("accounts/", include("accounts.urls")),
        path("content/", include("content.urls")),
        path("schema/", SpectacularAPIView.as_view(), name="schema"),
        path("docs/", SpectacularSwaggerView.as_view(url_name="schema"), name="docs"),
    ])),
]
