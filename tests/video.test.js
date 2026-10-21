import test from "node:test";
import assert from "node:assert/strict";
import { videoUrl, videoPlan } from "../packages/core/video-tools.js";
test("video plans validate URLs, rights constraints and quality without accepting command arguments", () => {
  for (const url of [
    "file:///etc/passwd",
    "--exec=bad",
    "https://user:password@example.org/video",
  ])
    assert.throws(() => videoUrl(url));
  for (const info of [
    { is_live: true },
    { has_drm: true },
    { _type: "playlist" },
  ])
    assert.throws(() =>
      videoPlan({ ...info, webpage_url: "https://example.org/watch" }),
    );
  assert.throws(() =>
    videoPlan({ webpage_url: "https://example.org/watch" }, "1080; rm -rf"),
  );
  const plan = videoPlan(
    {
      title: "../../A video",
      webpage_url: "https://example.org/watch?id=123",
      id: "123",
      uploader: "Creator",
      license: "CC BY 4.0",
    },
    "720",
  );
  assert.equal(plan.driver, "video");
  assert.equal(plan.type, "video");
  assert.ok(!plan.filename.includes("/"));
  assert.equal(plan.rights, "CC BY 4.0");
  assert.equal(plan.source.creator, "Creator");
  assert.equal(plan.quality, "720");
});
