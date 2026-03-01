# How Bluebell Works

---

This page provides a high-level overview of how Bluebell is structured and the key systems that power the platform.

## Platform Architecture

Bluebell is a web application with a clear separation between its frontend and backend:

- **Frontend** -- A React single-page application that runs in your browser
- **Backend** -- A Django REST API that handles data, authentication, and business logic
- **Media Pipeline** -- Asynchronous processing for video and audio content (transcoding, normalization, streaming)

## Content Types

Bluebell supports several types of content:

### Projects (Games)
Projects are the primary content type, originally designed for games. A project can include:
- Downloadable assets (game builds for different platforms)
- Screenshots and cover images
- Descriptions with full markdown support
- Pricing (free, pay-what-you-want, or fixed price)
- Ratings and comments from users

### Posts
Posts are creator updates that can include:
- Rich text content (formatted with a WYSIWYG editor)
- Video uploads (automatically transcoded to adaptive streaming)
- Audio uploads (normalized and converted to HLS streaming)
- Visibility controls (public, subscribers-only, or gated behind Boost)

### Game Jams
Community events where creators build games around a theme within a time constraint.

## Key Systems

### Authentication
Bluebell uses session-based authentication with support for AT Protocol (Bluesky) identity linking.

### Payments
All payments flow through Stripe Connect, with creators receiving direct payouts. Every transaction includes a transparent breakdown of fees.

### Media Processing
Uploaded video and audio is processed asynchronously:
- **Video**: Transcoded to adaptive HLS streaming (multiple quality levels)
- **Audio**: Normalized for consistent volume, converted to streaming format with waveform visualization

### Federation
Bluebell is built on the AT Protocol, enabling portable identity and the potential for cross-platform content distribution.
