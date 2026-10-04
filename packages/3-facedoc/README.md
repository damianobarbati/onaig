# ONAIG FaceDoc

Face enrollment with a document held beside the user's face. The package contains its own copy of the camera, landmark, pose and liveness controller, captures the final frame as a Base64 image, and sends it with the live face embeddings to the stateless backend. It does not import or modify `../2-faceonly`.

The backend contract is implemented in `server.ts`. OCR and document-face extraction are provided through `setDocumentAnalyzer()`; the MVP deliberately fails closed with HTTP 503 until a self-hosted analyzer is configured. No image, embedding, or user record is persisted.

Run the UI on port 3003 and the API on port 3004. Run tests with `pnpm exec vitest run packages/3-facedoc` and build with `pnpm --dir packages/3-facedoc build`.
