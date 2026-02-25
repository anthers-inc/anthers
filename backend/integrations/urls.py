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
        views.PlatformConnectionListView.as_view(),
        name="platform-list",
    ),
    path(
        "platforms/connect/",
        views.APIKeyConnectView.as_view(),
        name="platform-api-key-connect",
    ),
    path(
        "platforms/<str:platform>/disconnect/",
        views.PlatformDisconnectView.as_view(),
        name="platform-disconnect",
    ),
    # YouTube OAuth
    path(
        "platforms/youtube/auth/",
        views.YouTubeAuthInitView.as_view(),
        name="youtube-auth-init",
    ),
    path(
        "platforms/youtube/callback/",
        views.YouTubeCallbackView.as_view(),
        name="youtube-callback",
    ),
    # Cross-publish
    path(
        "cross-publish/",
        views.CrossPublishResultListView.as_view(),
        name="cross-publish-list",
    ),
    path(
        "cross-publish/initiate/",
        views.CrossPublishInitView.as_view(),
        name="cross-publish-initiate",
    ),
]
