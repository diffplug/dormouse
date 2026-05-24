import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import Changelog from "./Changelog";

describe("Changelog route", () => {
  it("renders the after-version filter for /changelog/after/v0.9.0", () => {
    const router = createMemoryRouter(
      [
        {
          path: "/changelog/after/:version",
          element: <Changelog />,
        },
      ],
      {
        initialEntries: ["/changelog/after/v0.9.0"],
      },
    );

    expect(renderToStaticMarkup(<RouterProvider router={router} />)).toMatchSnapshot();
  });
});
