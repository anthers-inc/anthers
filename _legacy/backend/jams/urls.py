from django.urls import path

from . import views

urlpatterns = [
    path("", views.GameJamListCreateView.as_view(), name="jam-list-create"),
    path(
        "<slug:slug>/",
        views.GameJamDetailView.as_view(),
        name="jam-detail",
    ),
    path(
        "<slug:slug>/entries/",
        views.JamEntryListCreateView.as_view(),
        name="jam-entry-list-create",
    ),
    path(
        "<slug:slug>/entries/<int:pk>/vote/",
        views.JamEntryVoteView.as_view(),
        name="jam-entry-vote",
    ),
    path(
        "<slug:slug>/results/",
        views.JamResultsView.as_view(),
        name="jam-results",
    ),
]
