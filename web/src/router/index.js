import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "../stores/auth";
import LoginView from "../views/LoginView.vue";
import AdminLoginView from "../views/AdminLoginView.vue";
import DashboardView from "../views/DashboardView.vue";

const routes = [
  {
    path: "/login",
    component: LoginView
  },
  {
    path: "/admin/login",
    component: AdminLoginView
  },
  {
    path: "/",
    redirect: "/dashboard"
  },
  {
    path: "/dashboard",
    component: DashboardView
  }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.checked) {
    await auth.check();
  }

  if (to.path === "/login" || to.path === "/admin/login") {
    if (auth.authenticated) {
      return "/dashboard";
    }
    return true;
  }

  if (!auth.authenticated) {
    return "/login";
  }

  return true;
});

export default router;
