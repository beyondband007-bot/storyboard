from __future__ import annotations

import argparse
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from backend.auth import find_user_by_username, get_connection  # noqa: E402
from backend.models import ProjectState  # noqa: E402
from backend.storage import OUTPUTS_DIR  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Assign existing storyboard projects to a shared AI-workbench user.")
    parser.add_argument("username", help="Existing username/email in the shared jingchuang_ai.users table.")
    parser.add_argument("--dry-run", action="store_true", help="Show what would change without writing project files.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    connection = get_connection()
    try:
        user = find_user_by_username(connection, args.username)
    finally:
        connection.close()

    if not user:
        print(f"User not found in shared database: {args.username}", file=sys.stderr)
        return 1

    project_paths = sorted(OUTPUTS_DIR.glob("*/project.json"))
    changed = 0
    skipped = 0
    for path in project_paths:
        try:
            project = ProjectState.model_validate_json(path.read_text(encoding="utf-8"))
        except Exception as exc:
            skipped += 1
            print(f"skip invalid project: {path} ({exc})")
            continue

        if project.owner_user_id == int(user["id"]) and project.owner_external_id == user["externalId"]:
            skipped += 1
            continue

        project.owner_user_id = int(user["id"])
        project.owner_external_id = user["externalId"]
        changed += 1
        print(f"{'would assign' if args.dry_run else 'assigned'} {project.id} -> {args.username}")
        if not args.dry_run:
            path.write_text(project.model_dump_json(indent=2), encoding="utf-8")

    print(f"done: changed={changed}, skipped={skipped}, total={len(project_paths)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

