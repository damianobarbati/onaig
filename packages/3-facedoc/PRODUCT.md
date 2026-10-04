# ONAIG FaceDoc

## MVP behavior

The user enrolls while holding one document page next to their face. The existing ONAIG acquisition and liveness checks must pass. The client sends the captured camera frame as `documentImageBase64` and the live face embeddings to the backend.

The backend extracts the document face and the fields `firstName`, `lastName`, and `birthDate` through a self-hosted analyzer. It accepts the enrollment only when the document face embedding reaches the configured similarity threshold.

The backend is stateless. Images and embeddings exist only for the request and are never written to a database or filesystem.

## Security boundary

This is a face/document match and OCR screening flow. It does not prove document authenticity, validate a national registry, or provide regulated KYC.
