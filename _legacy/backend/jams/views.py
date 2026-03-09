from django.db.models import Avg, Count
from django.utils import timezone
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from content.models import Project

from .models import GameJam, JamEntry, JamVote
from .serializers import (
    GameJamListSerializer,
    GameJamSerializer,
    JamEntryResultSerializer,
    JamEntrySerializer,
    JamVoteSerializer,
)


class IsCreatorOrReadOnly(permissions.BasePermission):
    def has_permission(self, request, view):
        if request.method in permissions.SAFE_METHODS:
            return True
        return request.user.is_authenticated and request.user.is_creator

    def has_object_permission(self, request, view, obj):
        if request.method in permissions.SAFE_METHODS:
            return True
        return obj.creator == request.user


# ─── Game Jams ───


class GameJamListCreateView(generics.ListCreateAPIView):
    """List all jams or create a new one."""

    permission_classes = [IsCreatorOrReadOnly]

    def get_serializer_class(self):
        if self.request.method == "POST":
            return GameJamSerializer
        return GameJamListSerializer

    def get_queryset(self):
        qs = GameJam.objects.select_related("creator")

        # Filter by status
        status_filter = self.request.query_params.get("status")
        if status_filter:
            now = timezone.now()
            if status_filter == "upcoming":
                qs = qs.filter(start_at__gt=now)
            elif status_filter == "active":
                qs = qs.filter(start_at__lte=now, end_at__gt=now)
            elif status_filter == "voting":
                qs = qs.filter(end_at__lte=now, voting_end_at__gt=now)
            elif status_filter == "ended":
                qs = qs.filter(voting_end_at__lte=now)

        return qs

    def perform_create(self, serializer):
        serializer.save(creator=self.request.user)


class GameJamDetailView(generics.RetrieveUpdateDestroyAPIView):
    """Retrieve, update, or delete a game jam."""

    serializer_class = GameJamSerializer
    permission_classes = [IsCreatorOrReadOnly]
    lookup_field = "slug"

    def get_queryset(self):
        return GameJam.objects.select_related("creator")


# ─── Entries ───


class JamEntryListCreateView(generics.ListCreateAPIView):
    """List entries or submit a project to a jam."""

    serializer_class = JamEntrySerializer
    permission_classes = [permissions.IsAuthenticatedOrReadOnly]

    def get_jam(self):
        return GameJam.objects.get(slug=self.kwargs["slug"])

    def get_queryset(self):
        return (
            JamEntry.objects.filter(jam__slug=self.kwargs["slug"])
            .select_related("project", "submitted_by")
            .prefetch_related("votes")
        )

    def create(self, request, *args, **kwargs):
        try:
            jam = self.get_jam()
        except GameJam.DoesNotExist:
            return Response(
                {"detail": "Jam not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Validate jam is active (or allows late submissions)
        jam_status = jam.status
        if jam_status == "upcoming":
            return Response(
                {"detail": "This jam hasn't started yet."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if jam_status in ("voting", "ended") and not jam.allow_late_submissions:
            return Response(
                {"detail": "Submissions for this jam are closed."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        project_id = request.data.get("project")
        if not project_id:
            return Response(
                {"detail": "project is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Verify project ownership
        try:
            project = Project.objects.get(
                id=project_id, creator=request.user, is_published=True
            )
        except Project.DoesNotExist:
            return Response(
                {"detail": "Published project not found or you don't own it."},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Check for duplicate entry
        if JamEntry.objects.filter(jam=jam, project=project).exists():
            return Response(
                {"detail": "This project is already submitted to this jam."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        entry = JamEntry.objects.create(
            jam=jam, project=project, submitted_by=request.user
        )
        serializer = self.get_serializer(entry)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class JamEntryVoteView(APIView):
    """Vote on a jam entry."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, slug, pk):
        try:
            entry = JamEntry.objects.select_related("jam").get(
                pk=pk, jam__slug=slug
            )
        except JamEntry.DoesNotExist:
            return Response(
                {"detail": "Entry not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Only allow voting during voting period
        jam_status = entry.jam.status
        if jam_status != "voting":
            return Response(
                {"detail": f"Voting is not open (jam status: {jam_status})."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Can't vote on own entry
        if entry.submitted_by == request.user:
            return Response(
                {"detail": "You can't vote on your own entry."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        score = request.data.get("score")
        try:
            score = int(score)
            if score < 1 or score > 5:
                raise ValueError
        except (TypeError, ValueError):
            return Response(
                {"detail": "score must be an integer between 1 and 5."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        vote, created = JamVote.objects.update_or_create(
            entry=entry,
            user=request.user,
            defaults={"score": score},
        )

        return Response(
            JamVoteSerializer(vote).data,
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class JamResultsView(APIView):
    """Ranked results for a jam (only available after voting ends)."""

    permission_classes = [permissions.AllowAny]

    def get(self, request, slug):
        try:
            jam = GameJam.objects.get(slug=slug)
        except GameJam.DoesNotExist:
            return Response(
                {"detail": "Jam not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        if jam.status != "ended":
            return Response(
                {"detail": "Results are only available after voting ends."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        entries = (
            JamEntry.objects.filter(jam=jam)
            .select_related("project", "submitted_by")
            .prefetch_related("votes")
            .annotate(
                avg_score=Avg("votes__score"),
                num_votes=Count("votes"),
            )
            .order_by("-avg_score", "-num_votes")
        )

        results = []
        for rank, entry in enumerate(entries, start=1):
            entry.rank = rank
            results.append(entry)

        serializer = JamEntryResultSerializer(
            results, many=True, context={"request": request}
        )
        return Response(
            {
                "jam": GameJamSerializer(jam, context={"request": request}).data,
                "results": serializer.data,
            }
        )
