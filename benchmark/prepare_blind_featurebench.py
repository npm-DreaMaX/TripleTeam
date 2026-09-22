#!/usr/bin/env python3
"""Prepare a public, masked FeatureBench task without exposing evaluator data.

This is a development exercise preparer, not the official container harness.
The trusted preparer consumes the mask mechanically. Its output has no dataset,
removed implementation, held-out tests, original Git objects, or bytecode.
Requires pyarrow==19.0.1, isolated from TripleTeam's Node runtime dependencies.
"""

import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

import pyarrow.parquet as parquet


DATA_REVISION = "76b4a4566e04f4bcc13c35125d4f301791efa736"
DATA_SHA256 = "d775855a031b0fb5932ff7fdf4512ce733fbc6716528395bf15cbad22df5d2c3"
EVALUATOR_REVISION = "8d4e347ec57546685c5a87e8676bf575db022ea6"


def run(args, **kwargs):
    # Mask and test content must never be echoed into an agent transcript.
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    if result.returncode:
        raise RuntimeError("Trusted preparation command failed; no task was released")
    return result.stdout.decode().strip()


def prepare(parquet_path, instance_id, output):
    if hashlib.sha256(parquet_path.read_bytes()).hexdigest() != DATA_SHA256:
        raise ValueError("Dataset bytes differ from the pinned FeatureBench fast v1.1 snapshot")
    if output.exists():
        raise ValueError("Output must not already exist; a released blind task is immutable")
    columns = ["instance_id", "repo", "base_commit", "problem_statement", "image_name", "patch", "FAIL_TO_PASS"]
    rows = parquet.read_table(parquet_path, columns=columns).to_pylist()
    task = next((row for row in rows if row["instance_id"] == instance_id), None)
    if task is None:
        raise ValueError("Instance is not in the frozen fast split")
    # The native exercise reproduces masking but has no repository environment fixes.
    # Use the official RuntimeHandler for other repositories and for publishable scores.
    if task["repo"] != "pypa/packaging":
        raise ValueError("Native blind preparation is validated for pypa/packaging only; use the official harness otherwise")
    with tempfile.TemporaryDirectory(prefix="tripleteam-trusted-preparation-") as temporary:
        temporary = pathlib.Path(temporary)
        archive = temporary / "source.tar.gz"
        urllib.request.urlretrieve(
            "https://codeload.github.com/" + task["repo"] + "/tar.gz/" + task["base_commit"], archive
        )
        archive_digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        with tarfile.open(archive) as source:
            source.extractall(temporary, filter="data")
        repository = temporary / (task["repo"].split("/")[1] + "-" + task["base_commit"])
        run(["git", "-C", str(repository), "apply", "--whitespace=fix", "-"], input=task["patch"].encode())
        for test_path in task["FAIL_TO_PASS"]:
            path = (repository / test_path.removeprefix("/testbed/")).resolve()
            if not path.is_relative_to(repository):
                raise ValueError("Evaluator path escapes the repository")
            path.unlink(missing_ok=True)
        for cache in repository.rglob("__pycache__"):
            shutil.rmtree(cache)
        for pattern in ("*.pyc", "*.pyo"):
            for cache in repository.rglob(pattern):
                cache.unlink()
        shutil.rmtree(repository / ".git", ignore_errors=True)
        run(["git", "-C", str(repository), "init"])
        run(["git", "-C", str(repository), "config", "user.name", "Blind Benchmark"])
        run(["git", "-C", str(repository), "config", "user.email", "blind@localhost"])
        run(["git", "-C", str(repository), "add", "-A"])
        run(["git", "-C", str(repository), "commit", "-m", "FeatureBench masked public starter"])
        baseline = run(["git", "-C", str(repository), "rev-parse", "HEAD"])
        tree = run(["git", "-C", str(repository), "rev-parse", "HEAD^{tree}"])
        output.mkdir(parents=True)
        shutil.move(str(repository), output / "repo")
        (output / "TASK.md").write_text(task["problem_statement"])
        public = {
            "instance_id": instance_id,
            "problem_statement": task["problem_statement"],
            "repo": task["repo"],
            "image_name": task["image_name"],
            "prepared_base_commit": baseline,
            "prepared_base_tree": tree,
        }
        (output / "task.json").write_text(json.dumps(public, ensure_ascii=False, indent=2) + "\n")
        provenance = {
            "dataset_revision": DATA_REVISION,
            "dataset_sha256": DATA_SHA256,
            "evaluator_commit": EVALUATOR_REVISION,
            "source_commit": task["base_commit"],
            "source_archive_sha256": archive_digest,
            "baseline_commit": baseline,
            "baseline_tree": tree,
            "preparation": "Public source archive, mechanically masked, held-out files removed, fresh Git history. Native blind development exercise, not an official score.",
        }
        (output / "PROVENANCE.json").write_text(json.dumps(provenance, indent=2) + "\n")
        return {"public_directory": str(output), "baseline_commit": baseline, "baseline_tree": tree}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parquet", required=True, type=pathlib.Path)
    parser.add_argument("--instance", required=True)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    arguments = parser.parse_args()
    print(json.dumps(prepare(arguments.parquet, arguments.instance, arguments.output.resolve())))
