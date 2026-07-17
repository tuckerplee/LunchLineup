# Worker Parser

PDF parsing helpers for availability import jobs.

## Files

- `README.md`: this folder guide.
- `pdf_parser.py`: `pypdf` backed availability PDF parsing pipeline with explicit parse failures, normalized hashing of visible Employee ID/Staff ID values (including email identifiers), size/page/text caps, encrypted-PDF rejection, and hashed staff references for invalid uploads.
- `pdf_sandbox.py`: bounded Unix-socket client that transfers validated PDF bytes to the isolated parser without importing PDF parsing code.
- `pdf_service.py`: secret-free, no-network parser service and resource-limited child entrypoint; it handles one document before exiting so Compose clears all parser processes and temporary state.
