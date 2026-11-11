# Public explainer

The static page in `site/` explains wiki4llm's purpose and data flow. It is not
an installation inventory or a claim that every repository has been onboarded.
Use only the wiki4llm brand on this page. Keep private project names, installation
identifiers, server addresses and domain names out of its content and assets.
The page loads no external fonts, scripts, analytics or images.

The Pages workflow uploads only `site/`, never the repository root, operator data,
test corpora or deployment receipts. Enable GitHub Pages with GitHub Actions as
the source; deployments run only from `main` in the `github-pages` environment.
The workflow uses GitHub's default Pages hosting without a custom domain.

For local inspection, serve `site/` with a static HTTP server. Check desktop and
mobile layouts, anchor navigation, keyboard focus and content scope before pushing.
Read back the deployed HTML/CSS and successful Pages run before sharing the link.
Page changes do not deploy the MCP gate, alter reader rights or index documents.
