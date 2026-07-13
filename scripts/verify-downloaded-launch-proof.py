#!/usr/bin/env python3
import argparse
import datetime
import hashlib
import json
from pathlib import Path


def parse_timestamp(value, label):
    if not isinstance(value, str):
        raise ValueError(f"{label} must be an ISO-8601 timestamp.")
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"{label} must be an ISO-8601 timestamp.") from error
    if parsed.tzinfo is None:
        raise ValueError(f"{label} must include a timezone.")
    return parsed.astimezone(datetime.timezone.utc)


def require_fresh(timestamp, label, now, max_age_seconds):
    if timestamp > now + datetime.timedelta(minutes=5):
        raise ValueError(f"{label} is too far in the future.")
    if now - timestamp > datetime.timedelta(seconds=max_age_seconds):
        raise ValueError(f"{label} exceeds LAUNCH_PROOF_MAX_AGE_SECONDS.")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Verify retained launch-proof bytes before VM217 records deployment success."
    )
    parser.add_argument("proof_path", type=Path)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--max-age-seconds", required=True, type=int)
    parser.add_argument("--verification-time")
    parser.add_argument("--mode", choices=("candidate", "rollback"), default="candidate")
    return parser.parse_args()


def main():
    args = parse_args()
    if args.max_age_seconds <= 0:
        raise ValueError("LAUNCH_PROOF_MAX_AGE_SECONDS must be a positive integer.")
    if len(args.source_sha) != 40 or any(character not in "0123456789abcdefABCDEF" for character in args.source_sha):
        raise ValueError("source SHA must be a full 40-character Git SHA.")
    if len(args.sha256) != 64 or any(character not in "0123456789abcdefABCDEF" for character in args.sha256):
        raise ValueError("expected SHA-256 must be a 64-character hexadecimal digest.")

    proof_bytes = args.proof_path.read_bytes()
    actual_sha256 = hashlib.sha256(proof_bytes).hexdigest()
    if actual_sha256 != args.sha256.lower():
        raise ValueError(
            f"Downloaded launch proof SHA-256 {actual_sha256} does not match the CI-verified LAUNCH_PROOF_ARTIFACT_SHA256."
        )

    proof = json.loads(proof_bytes)
    if proof.get("sourceSha") != args.source_sha:
        raise ValueError("Downloaded launch proof sourceSha does not match RELEASE_SOURCE_SHA.")

    now = (
        parse_timestamp(args.verification_time, "verification time")
        if args.verification_time
        else datetime.datetime.now(datetime.timezone.utc)
    )
    generated_at = parse_timestamp(proof.get("generatedAt"), "launchProof.generatedAt")
    if args.mode == "candidate":
        require_fresh(generated_at, "launchProof.generatedAt", now, args.max_age_seconds)

    evidence = proof.get("evidence")
    if not isinstance(evidence, dict) or not evidence:
        raise ValueError("launchProof.evidence is required.")
    for key, entry in evidence.items():
        if not isinstance(entry, dict):
            raise ValueError(f"launchProof.evidence.{key} must be an object.")
        label = f"launchProof.evidence.{key}.checkedAt"
        checked_at = parse_timestamp(entry.get("checkedAt"), label)
        if args.mode == "candidate":
            require_fresh(checked_at, label, now, args.max_age_seconds)
        if checked_at > generated_at:
            raise ValueError(f"{label} must not be later than generatedAt.")

    print(
        "downloaded_launch_proof_ok "
        f"source_sha={args.source_sha} sha256={actual_sha256} bytes={len(proof_bytes)} mode={args.mode}"
    )


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(str(error)) from error
