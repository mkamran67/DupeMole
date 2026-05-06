import type { RouteObject } from "react-router-dom";
import { Navigate } from "react-router-dom";
import NotFound from "../pages/NotFound";
import AppPage from "../pages/app/page";

const routes: RouteObject[] = [
  {
    path: "/",
    element: <Navigate to="/app" replace />,
  },
  {
    path: "/app",
    element: <AppPage />,
  },
  {
    path: "/app/compare/:groupId",
    element: <AppPage />,
  },
  {
    path: "*",
    element: <NotFound />,
  },
];

export default routes;
