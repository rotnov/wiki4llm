import json
import subprocess
import sys

import pytest
from conftest import config_file, git, tracked

from wiki_rag import RagError, load_config


class FakeProvider:
    """Recording provider with Files and vector-store response shapes."""

    def __init__(self):
        self.files = {}
        self.attachments = {}
        self.uploads = 0
        self.deleted = []
        self.fail_poll = False
        self.unknown_upload = False
        self.unknown_attach = False
        self.permission = False

    def store_empty(self, store):
        return not any(s == store for s, _ in self.attachments)

    def upload(self, filename, content):
        self.uploads += 1
        if self.permission:
            raise RagError("provider permission denied (HTTP 403)")
        fid = f"file-{self.uploads}"
        self.files[fid] = {
            "id": fid,
            "filename": filename,
            "bytes": len(content),
            "content": content,
            "object": "file",
        }
        if self.unknown_upload:
            self.unknown_upload = False
            raise RagError("unknown upload outcome")
        return fid

    def reconcile_upload(self, filename, sha):
        from wiki_rag.selection import digest

        matches = [
            f["id"]
            for f in self.files.values()
            if f["filename"] == filename and digest(f["content"]) == sha
        ]
        if len(matches) != 1:
            raise RagError("unresolved upload outcome")
        return matches[0]

    def attach(self, store, fid, attributes, chunking):
        self.attachments[store, fid] = {
            "id": fid,
            "vector_store_id": store,
            "attributes": attributes,
            "status": "completed",
        }
        if self.unknown_attach:
            self.unknown_attach = False
            raise RagError("unknown attachment outcome")

    def attach_batch(self, store, items, chunking):
        for item in items:
            self.attach(store, item["file_id"], item["attributes"], chunking)
        return {"id": "vsfb_test", "status": "in_progress"}

    def attachments_by_id(self, store, ids):
        return {
            fid: self.attachments[store, fid] for fid in ids if (store, fid) in self.attachments
        }

    def attachment(self, store, fid):
        return self.attachments.get((store, fid))

    def wait_completed(self, store, fid):
        if self.fail_poll:
            raise RagError("ingestion failed")
        assert self.attachments[store, fid]["status"] == "completed"

    def delete_attachment(self, store, fid):
        self.attachments.pop((store, fid), None)
        self.deleted.append((store, fid))

    def delete_file(self, fid):
        self.files.pop(fid, None)
        self.deleted.append(fid)


def engine():
    import wiki_rag

    assert hasattr(wiki_rag, "run"), "durable ingestion engine is not implemented"
    return wiki_rag


def setup(tmp_path, repo):
    tracked(repo, "README.md")
    cfg = load_config(config_file(tmp_path, repo))
    return cfg, FakeProvider()


def active(app, cfg):
    return app.read_manifest(cfg.state / "manifest.json")["collections"]["guide"]["files"]


def test_unchanged_replacement_deletion_rename(tmp_path, repo):
    app = engine()
    cfg, provider = setup(tmp_path, repo)
    app.run(cfg, "index", apply=True, provider=provider)
    first = active(app, cfg)["README.md"]["file_id"]
    app.run(cfg, "update", apply=True, provider=provider)
    assert provider.uploads == 1
    tracked(repo, "README.md", "changed")
    plan = app.run(cfg, "plan")
    assert plan["collections"]["guide"]["changes"][0]["action"] == "replace"
    app.run(cfg, "update", apply=True, provider=provider)
    assert provider.uploads == 2 and first not in provider.files
    git(repo, "mv", "README.md", "RENAMED.md")
    app.run(cfg, "update", apply=True, provider=provider)
    assert set(active(app, cfg)) == {"RENAMED.md"}
    (repo / "RENAMED.md").unlink()
    app.run(cfg, "update", apply=True, provider=provider)
    assert active(app, cfg) == {} and provider.files == {}


def test_failure_preserves_active_and_resume_uses_staged_upload(tmp_path, repo):
    app = engine()
    cfg, provider = setup(tmp_path, repo)
    app.run(cfg, "index", apply=True, provider=provider)
    old = active(app, cfg)
    tracked(repo, "README.md", "new")
    provider.fail_poll = True
    with pytest.raises(RagError, match="ingestion"):
        app.run(cfg, "update", apply=True, provider=provider)
    assert active(app, cfg) == old and provider.deleted == []
    provider.fail_poll = False
    app.run(cfg, "update", apply=True, provider=provider)
    assert provider.uploads == 2
    assert active(app, cfg) != old


@pytest.mark.parametrize("failure", ["unknown_upload", "unknown_attach"])
def test_unknown_outcome_is_reconciled_without_duplicate_create(tmp_path, repo, failure):
    app = engine()
    cfg, provider = setup(tmp_path, repo)
    setattr(provider, failure, True)
    with pytest.raises(RagError, match="unknown"):
        app.run(cfg, "index", apply=True, provider=provider)
    app.run(cfg, "update", apply=True, provider=provider)
    assert provider.uploads == 1
    assert active(app, cfg)["README.md"]["file_id"] == "file-1"


def test_preview_never_constructs_provider(tmp_path, repo, monkeypatch):
    app = engine()
    cfg, _ = setup(tmp_path, repo)
    import wiki_rag.engine as module

    def forbidden(*args):
        raise AssertionError("network provider constructed during preview")

    monkeypatch.setattr(module, "OpenAIProvider", forbidden)
    for command in ["plan", "index", "update", "status"]:
        app.run(cfg, command)
    assert not cfg.state.exists()


def test_missing_corrupt_and_mismatched_state_fail_closed(tmp_path, repo):
    app = engine()
    cfg, provider = setup(tmp_path, repo)
    with pytest.raises(RagError, match="missing"):
        app.run(cfg, "update", apply=True, provider=provider)
    app.run(cfg, "index", apply=True, provider=provider)
    path = cfg.state / "state.json"
    original = path.read_bytes()
    path.write_text("{}")
    with pytest.raises(RagError, match="state"):
        app.run(cfg, "index", apply=True, provider=provider)
    path.write_bytes(original)
    cfg2path = config_file(tmp_path, repo)
    cfg2path.write_text(cfg2path.read_text().replace("proj_test", "proj_other"))
    with pytest.raises(RagError, match="ownership"):
        app.run(load_config(cfg2path), "update", apply=True, provider=provider)
    path.unlink()
    with pytest.raises(RagError, match="missing"):
        app.run(cfg, "index", apply=True, provider=provider)
    assert provider.deleted == []


def test_fresh_state_rejects_nonempty_store_and_preserves_foreign_files(tmp_path, repo):
    app = engine()
    cfg, provider = setup(tmp_path, repo)
    provider.attachments["vs_test", "file-foreign"] = {"status": "completed"}
    with pytest.raises(RagError, match="empty"):
        app.run(cfg, "index", apply=True, provider=provider)
    assert provider.uploads == 0 and provider.deleted == []


def test_foreign_attachment_survives_cleanup(tmp_path, repo):
    app = engine()
    cfg, provider = setup(tmp_path, repo)
    app.run(cfg, "index", apply=True, provider=provider)
    provider.attachments["vs_test", "file-foreign"] = {"status": "completed"}
    (repo / "README.md").unlink()
    app.run(cfg, "update", apply=True, provider=provider)
    assert ("vs_test", "file-foreign") in provider.attachments


def test_duplicate_basenames_and_active_gate_filter(tmp_path, repo):
    app = engine()
    cfg, provider = setup(tmp_path, repo)
    second = tmp_path / "second"
    second.mkdir()
    git(second, "init", "-b", "main")
    tracked(second, "README.md", "second repo")
    path = config_file(tmp_path, repo)
    path.write_text(
        path.read_text()
        + f'''\n[[collections]]
name = "second"
repository = "example/second"
root = "{second}"
vector_store_id = "vs_second"
include = ["**/*.md"]
extensions = [".md"]
'''
    )
    cfg = load_config(path)
    app.run(cfg, "index", apply=True, provider=provider)
    manifest = app.read_manifest(cfg.state / "manifest.json")
    fid = manifest["collections"]["second"]["files"]["README.md"]["file_id"]
    assert fid != active(app, cfg)["README.md"]["file_id"]
    assert app.is_active(manifest, "proj_test", "second", "vs_second", fid)
    assert not app.is_active(manifest, "proj_test", "guide", "vs_test", fid)
    assert not app.is_active(manifest, "proj_other", "second", "vs_second", fid)
    assert not app.is_active(manifest, "proj_test", "second", "vs_second", "staged-id")


def test_process_lock_contention(tmp_path):
    engine()
    from wiki_rag.state import StateLock

    with StateLock(tmp_path):
        code = (
            "from pathlib import Path; from wiki_rag.state import StateLock; "
            f"StateLock(Path({str(tmp_path)!r})).__enter__()"
        )
        result = subprocess.run([sys.executable, "-c", code], capture_output=True)
        assert result.returncode != 0 and b"locked" in result.stderr


def test_provider_permission_failure_keeps_no_published_snapshot(tmp_path, repo):
    app = engine()
    cfg, provider = setup(tmp_path, repo)
    provider.permission = True
    with pytest.raises(RagError, match="permission"):
        app.run(cfg, "index", apply=True, provider=provider)
    assert app.read_manifest(cfg.state / "manifest.json")["collections"] == {}


def test_stale_commit_and_changed_source_during_upload_block_publication(tmp_path, repo):
    app = engine()
    cfg, provider = setup(tmp_path, repo)
    git(repo, "commit", "-m", "first")
    previous = git(repo, "rev-parse", "HEAD")
    tracked(repo, "README.md", "second")
    git(repo, "commit", "-am", "second")
    app.run(cfg, "index", apply=True, provider=provider)
    old = active(app, cfg)
    git(repo, "checkout", previous)
    with pytest.raises(RagError, match="stale"):
        app.run(cfg, "update", apply=True, provider=provider)
    assert active(app, cfg) == old
    git(repo, "checkout", "main")
    tracked(repo, "README.md", "third")
    upload = provider.upload

    def mutate(*args):
        fid = upload(*args)
        tracked(repo, "README.md", "fourth")
        return fid

    provider.upload = mutate
    with pytest.raises(RagError, match="changed"):
        app.run(cfg, "update", apply=True, provider=provider)
    assert active(app, cfg) == old


def test_explicit_rejection_can_resume_after_permission_fix(tmp_path, repo):
    app = engine()
    from wiki_rag.provider import RejectedWrite

    cfg, provider = setup(tmp_path, repo)
    upload = provider.upload
    provider.upload = lambda *args: (_ for _ in ()).throw(
        RejectedWrite("provider permission denied")
    )
    with pytest.raises(RejectedWrite):
        app.run(cfg, "index", apply=True, provider=provider)
    provider.upload = upload
    app.run(cfg, "update", apply=True, provider=provider)
    assert provider.uploads == 1


def test_noop_publication_identity_and_all_collection_failure_atomicity(tmp_path, repo):
    app = engine()
    cfg, provider = setup(tmp_path, repo)
    app.run(cfg, "index", apply=True, provider=provider)
    before = app.read_manifest(cfg.state / "manifest.json")
    app.run(cfg, "update", apply=True, provider=provider)
    assert app.read_manifest(cfg.state / "manifest.json") == before
    tracked(repo, "README.md", "replacement")
    tracked(repo, "second.md", "new")
    poll = provider.wait_completed

    def fail_second(store, fid):
        if fid == "file-3":
            raise RagError("ingestion failure on second file")
        poll(store, fid)

    provider.wait_completed = fail_second
    with pytest.raises(RagError):
        app.run(cfg, "update", apply=True, provider=provider)
    assert app.read_manifest(cfg.state / "manifest.json") == before
    assert provider.deleted == []


def test_unknown_unseen_upload_never_recreated(tmp_path, repo):
    app = engine()
    cfg, provider = setup(tmp_path, repo)
    provider.upload = lambda *args: (_ for _ in ()).throw(RagError("unknown outcome"))
    with pytest.raises(RagError):
        app.run(cfg, "index", apply=True, provider=provider)
    for _ in range(2):
        with pytest.raises(RagError, match="unresolved"):
            app.run(cfg, "update", apply=True, provider=provider)
    assert provider.uploads == 0


def test_cleanup_failure_is_reported_after_publish_and_retries(tmp_path, repo):
    app = engine()
    cfg, provider = setup(tmp_path, repo)
    app.run(cfg, "index", apply=True, provider=provider)
    tracked(repo, "README.md", "new")
    delete = provider.delete_file
    provider.delete_file = lambda *args: (_ for _ in ()).throw(RagError("provider unavailable"))
    result = app.run(cfg, "update", apply=True, provider=provider)
    assert result["cleanup_pending"] == "provider unavailable"
    assert active(app, cfg)["README.md"]["file_id"] == "file-2"
    provider.delete_file = delete
    app.run(cfg, "update", apply=True, provider=provider)
    assert set(provider.files) == {"file-2"}


def test_manifest_reader_rejects_malformed_entries(tmp_path):
    app = engine()
    path = tmp_path / "manifest.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "project_id": "proj_test",
                "publication_id": "bad",
                "generation": 1,
                "collections": {
                    "bad": {
                        "vector_store_id": "vs_test",
                        "files": {
                            "a.md": {
                                "path": "a.md",
                                "file_id": "file-1",
                                "vector_store_id": "vs_test",
                            }
                        },
                    }
                },
            }
        )
    )
    with pytest.raises(RagError, match="manifest"):
        app.read_manifest(path)


def test_dirty_working_tree_has_no_false_committed_provenance(tmp_path, repo):
    app = engine()
    cfg, provider = setup(tmp_path, repo)
    git(repo, "commit", "-m", "committed baseline")
    head = git(repo, "rev-parse", "HEAD")
    tracked(repo, "clean.md", "committed clean")
    git(repo, "commit", "-m", "clean document")
    head = git(repo, "rev-parse", "HEAD")
    tracked(repo, "README.md", "uncommitted bytes")
    app.run(cfg, "index", apply=True, provider=provider)
    files = active(app, cfg)
    assert files["README.md"]["source_commit"] is None
    assert files["clean.md"]["source_commit"] == head


def test_native_pdf_published_processing_contract(tmp_path, repo):
    app = engine()
    cfg, provider = setup(tmp_path, repo)
    tracked(repo, "manual.pdf", b"%PDF-1.7\n\x00\n%%EOF\n")
    app.run(cfg, "index", apply=True, provider=provider)
    files = active(app, cfg)
    assert "manual.pdf" in files, "native PDF not published"
    item = files["manual.pdf"]
    assert item["kind"] == "pdf" and item["preprocessing"] == "pdf-native-v1"
    assert provider.files[item["file_id"]]["filename"].endswith(".pdf")
    assert files["README.md"]["preprocessing"] == "utf8-text-v1"


@pytest.mark.parametrize("when", ["before", "after"])
def test_interrupted_attachment_delete_is_journaled_before_reverted_version_reuse(
    tmp_path, repo, when
):
    app = engine()
    from wiki_rag.state import load_state

    cfg, provider = setup(tmp_path, repo)
    git(repo, "commit", "-m", "first")
    app.run(cfg, "index", apply=True, provider=provider)
    old = active(app, cfg)["README.md"]
    tracked(repo, "README.md", "replacement")
    git(repo, "commit", "-am", "replacement")
    delete = provider.delete_attachment

    def interrupt(store, fid):
        if fid == old["file_id"]:
            assert load_state(cfg)["operations"][old["operation_id"]]["phase"] == "detach_pending"
            if when == "after":
                delete(store, fid)
            raise KeyboardInterrupt()
        delete(store, fid)

    provider.delete_attachment = interrupt
    with pytest.raises(KeyboardInterrupt):
        app.run(cfg, "update", apply=True, provider=provider)
    provider.delete_attachment = delete
    tracked(repo, "README.md", "hello\n")
    git(repo, "commit", "-am", "restore first version")
    app.run(cfg, "update", apply=True, provider=provider)
    restored = active(app, cfg)["README.md"]
    assert restored["file_id"] != old["file_id"]
    assert provider.attachment("vs_test", restored["file_id"])["status"] == "completed"


def test_reverted_version_keeps_owned_file_until_pending_file_delete_finishes(tmp_path, repo):
    app = engine()
    from wiki_rag.state import load_state

    cfg, provider = setup(tmp_path, repo)
    app.run(cfg, "index", apply=True, provider=provider)
    old = active(app, cfg)["README.md"]
    tracked(repo, "README.md", "replacement")
    delete = provider.delete_file

    def unavailable(fid):
        if fid == old["file_id"]:
            raise RagError("file deletion unavailable")
        delete(fid)

    provider.delete_file = unavailable
    app.run(cfg, "update", apply=True, provider=provider)
    tracked(repo, "README.md", "hello\n")
    before = app.read_manifest(cfg.state / "manifest.json")
    with pytest.raises(RagError, match="deletion unavailable"):
        app.run(cfg, "update", apply=True, provider=provider)
    assert app.read_manifest(cfg.state / "manifest.json") == before
    assert any(op.get("file_id") == old["file_id"] for op in load_state(cfg)["operations"].values())
    provider.delete_file = delete
    app.run(cfg, "update", apply=True, provider=provider)
    assert old["file_id"] not in provider.files
    assert active(app, cfg)["README.md"]["file_id"] != old["file_id"]


@pytest.mark.parametrize("when", ["before", "after"])
def test_file_delete_intent_survives_interruption(tmp_path, repo, when):
    app = engine()
    from wiki_rag.state import load_state

    cfg, provider = setup(tmp_path, repo)
    app.run(cfg, "index", apply=True, provider=provider)
    old = active(app, cfg)["README.md"]
    tracked(repo, "README.md", "replacement")
    delete = provider.delete_file

    def interrupt(fid):
        assert load_state(cfg)["operations"][old["operation_id"]]["phase"] == "file_delete_pending"
        if when == "after":
            delete(fid)
        raise KeyboardInterrupt()

    provider.delete_file = interrupt
    with pytest.raises(KeyboardInterrupt):
        app.run(cfg, "update", apply=True, provider=provider)
    provider.delete_file = delete
    tracked(repo, "README.md", "hello\n")
    app.run(cfg, "update", apply=True, provider=provider)
    assert old["file_id"] not in provider.files
    assert active(app, cfg)["README.md"]["file_id"] != old["file_id"]


def test_confirmed_terminal_failure_retries_new_attempt_and_preserves_old_publication(
    tmp_path, repo
):
    app = engine()
    import wiki_rag.provider as provider_module

    assert hasattr(provider_module, "TerminalIngestionFailure"), "terminal recovery is missing"
    from wiki_rag.state import load_state

    cfg, provider = setup(tmp_path, repo)
    app.run(cfg, "index", apply=True, provider=provider)
    old = app.read_manifest(cfg.state / "manifest.json")
    tracked(repo, "README.md", "replacement")
    poll = provider.wait_completed

    def failed(store, fid):
        if fid == "file-2":
            raise provider_module.TerminalIngestionFailure("failed")
        poll(store, fid)

    provider.wait_completed = failed
    with pytest.raises(provider_module.TerminalIngestionFailure):
        app.run(cfg, "update", apply=True, provider=provider)
    assert app.read_manifest(cfg.state / "manifest.json") == old
    app.run(cfg, "update", apply=True, provider=provider)
    assert active(app, cfg)["README.md"]["file_id"] == "file-3"
    assert "file-2" not in provider.files
    assert any(
        op.get("file_id") == "file-2" and op["phase"] == "deleted"
        for op in load_state(cfg)["operations"].values()
    )


def test_terminal_failure_retries_are_bounded_across_restarts(tmp_path, repo):
    app = engine()
    import wiki_rag.provider as provider_module

    assert hasattr(provider_module, "TerminalIngestionFailure"), "terminal recovery is missing"

    cfg, provider = setup(tmp_path, repo)

    def failed(*args):
        raise provider_module.TerminalIngestionFailure("cancelled")

    provider.wait_completed = failed
    for command in ["index", "update", "update"]:
        with pytest.raises(provider_module.TerminalIngestionFailure):
            app.run(cfg, command, apply=True, provider=provider)
    for _ in range(2):
        with pytest.raises(RagError, match="retry limit"):
            app.run(cfg, "update", apply=True, provider=provider)
    assert provider.uploads == 3
    assert app.read_manifest(cfg.state / "manifest.json")["collections"] == {}


def test_terminal_retry_retirement_survives_unknown_delete_result(tmp_path, repo):
    app = engine()
    import wiki_rag.provider as provider_module

    assert hasattr(provider_module, "TerminalIngestionFailure"), "terminal recovery is missing"

    cfg, provider = setup(tmp_path, repo)
    poll = provider.wait_completed

    def failed(store, fid):
        if fid == "file-1":
            raise provider_module.TerminalIngestionFailure("failed")
        poll(store, fid)

    provider.wait_completed = failed
    with pytest.raises(provider_module.TerminalIngestionFailure):
        app.run(cfg, "index", apply=True, provider=provider)
    delete = provider.delete_attachment

    def lost(store, fid):
        delete(store, fid)
        raise RagError("lost delete response")

    provider.delete_attachment = lost
    with pytest.raises(RagError, match="lost delete"):
        app.run(cfg, "update", apply=True, provider=provider)
    assert provider.uploads == 1
    provider.delete_attachment = delete
    app.run(cfg, "update", apply=True, provider=provider)
    assert active(app, cfg)["README.md"]["file_id"] == "file-2"
