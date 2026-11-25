export async function loadWorkplaceAssets() {
  return new Map([
    [
      "/index.html",
      {
        contentType: "text/html; charset=utf-8",
        body: new TextEncoder().encode(
          "<!doctype html><title>Workplace</title><p>The UI bundle is not built.</p>",
        ),
      },
    ],
  ]);
}
