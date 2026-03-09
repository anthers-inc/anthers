from rest_framework import serializers

from .models import GameJam, JamEntry, JamVote


class GameJamSerializer(serializers.ModelSerializer):
    creator_username = serializers.CharField(
        source="creator.username", read_only=True
    )
    status = serializers.CharField(read_only=True)
    entry_count = serializers.IntegerField(read_only=True)
    theme = serializers.SerializerMethodField()

    class Meta:
        model = GameJam
        fields = (
            "id",
            "creator",
            "creator_username",
            "title",
            "slug",
            "description",
            "theme",
            "cover_image",
            "start_at",
            "end_at",
            "voting_end_at",
            "max_team_size",
            "allow_late_submissions",
            "status",
            "entry_count",
            "created_at",
            "updated_at",
        )
        read_only_fields = (
            "id",
            "creator",
            "creator_username",
            "status",
            "entry_count",
            "created_at",
            "updated_at",
        )

    def get_theme(self, obj):
        """Hide theme until jam starts."""
        if obj.is_theme_visible:
            return obj.theme
        return None


class GameJamListSerializer(serializers.ModelSerializer):
    creator_username = serializers.CharField(
        source="creator.username", read_only=True
    )
    status = serializers.CharField(read_only=True)
    entry_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = GameJam
        fields = (
            "id",
            "creator_username",
            "title",
            "slug",
            "cover_image",
            "start_at",
            "end_at",
            "voting_end_at",
            "status",
            "entry_count",
            "created_at",
        )


class JamEntrySerializer(serializers.ModelSerializer):
    project_title = serializers.CharField(
        source="project.title", read_only=True
    )
    project_slug = serializers.CharField(
        source="project.slug", read_only=True
    )
    project_cover = serializers.ImageField(
        source="project.cover_image", read_only=True
    )
    submitted_by_username = serializers.CharField(
        source="submitted_by.username", read_only=True
    )
    average_score = serializers.SerializerMethodField()
    vote_count = serializers.SerializerMethodField()
    user_vote = serializers.SerializerMethodField()

    class Meta:
        model = JamEntry
        fields = (
            "id",
            "jam",
            "project",
            "project_title",
            "project_slug",
            "project_cover",
            "submitted_by",
            "submitted_by_username",
            "average_score",
            "vote_count",
            "user_vote",
            "created_at",
        )
        read_only_fields = (
            "id",
            "jam",
            "submitted_by",
            "submitted_by_username",
            "project_title",
            "project_slug",
            "project_cover",
            "average_score",
            "vote_count",
            "user_vote",
            "created_at",
        )

    def get_average_score(self, obj):
        votes = obj.votes.all()
        if not votes:
            return None
        return round(sum(v.score for v in votes) / len(votes), 1)

    def get_vote_count(self, obj):
        return obj.votes.count()

    def get_user_vote(self, obj):
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return None
        vote = obj.votes.filter(user=request.user).first()
        return vote.score if vote else None


class JamEntryResultSerializer(JamEntrySerializer):
    """Entry serializer for results view — includes ranking."""

    rank = serializers.IntegerField(read_only=True)

    class Meta(JamEntrySerializer.Meta):
        fields = JamEntrySerializer.Meta.fields + ("rank",)


class JamVoteSerializer(serializers.ModelSerializer):
    class Meta:
        model = JamVote
        fields = ("id", "entry", "user", "score", "created_at")
        read_only_fields = ("id", "entry", "user", "created_at")
