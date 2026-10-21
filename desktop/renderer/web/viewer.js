import { icon } from "../icons.js";

const $ = (id) => document.getElementById(id);
$("back").append(icon("chevron-left"));
$("forward").append(icon("chevron-right"));
$("home").append(icon("refresh"));
for (const name of ["back", "forward", "home", "scripts"])
  $(name).onclick = () => window.savedPage.command(name);

window.savedPage.onState((state) => {
  $("back").disabled = !state.back;
  $("forward").disabled = !state.forward;
  $("url").textContent = state.url.replace(/^https?:\/\//, "");
  $("url").title = state.url;
  $("badge").textContent = state.saved ? "Saved copy" : "Not saved";
  $("badge").classList.toggle("missing", !state.saved);
  const date = new Date(state.captured);
  $("captured").textContent = Number.isNaN(date.getTime())
    ? ""
    : `${state.wayback ? "Wayback Machine copy from" : "Saved"} ${date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`;
  $("captured").title = `${state.files} files in this copy. Nothing is loaded from the internet.`;
  $("scripts").textContent = state.scripts ? "Scripts on" : "Scripts off";
  $("scripts").setAttribute("aria-pressed", String(state.scripts));
  $("scripts").title = state.scripts
    ? "The page’s own scripts are running, cut off from the internet. Turn them off if the page misbehaves."
    : "The page’s scripts are switched off. Turn them on if parts of the page are missing.";
  document.body.classList.toggle("loading", state.loading);
});
window.savedPage.command("ready");
