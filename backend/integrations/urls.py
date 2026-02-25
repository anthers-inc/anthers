from django.urls import path

from . import views

urlpatterns = [
    # Native analytics
    path(
        "analytics/overview/",
        views.AnalyticsOverviewView.as_view(),
        name="analytics-overview",
    ),
    path(
        "analytics/content/",
        views.ContentAnalyticsView.as_view(),
        name="analytics-content",
    ),
    path(
        "analytics/timeseries/",
        views.AnalyticsTimeseriesView.as_view(),
        name="analytics-timeseries",
    ),
    path(
        "analytics/comparison/",
        views.CrossPlatformComparisonView.as_view(),
        name="analytics-comparison",
    ),
    # Platform connections
    path(
        "platforms/",
        views.PlatformConnectionListCreateView.as_view(),
        name="platform-list-create",
    ),
    path(
        "platforms/<str:platform>/",
        views.PlatformConnectionDetailView.as_view(),
        name="platform-detail",
    ),
    # Cross-publish results
    path(
        "cross-publish/",
        views.CrossPublishResultListView.as_view(),
        name="cross-publish-list",
    ),
]
