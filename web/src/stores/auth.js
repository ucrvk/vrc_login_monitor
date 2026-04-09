import { defineStore } from "pinia";
import { apiFetch } from "../api/http";

export const useAuthStore = defineStore("auth", {
  state: () => ({
    checked: false,
    role: "",
    adminAuthenticated: false,
    userAuthenticated: false,
    loginUserId: null,
    usrid: "",
    displayName: ""
  }),
  getters: {
    authenticated(state) {
      return state.adminAuthenticated || state.userAuthenticated;
    },
    isAdmin(state) {
      return state.adminAuthenticated;
    },
    isUser(state) {
      return state.userAuthenticated;
    }
  },
  actions: {
    applyUserSession(loginUser) {
      this.adminAuthenticated = false;
      this.userAuthenticated = true;
      this.role = "user";
      this.loginUserId = loginUser?.id || null;
      this.usrid = loginUser?.usrid || "";
      this.displayName = loginUser?.displayName || "";
      this.checked = true;
    },
    async check() {
      let role = "";
      try {
        const [adminMe, userMe] = await Promise.all([
          apiFetch("/api/admin/me").catch(() => ({ authenticated: false })),
          apiFetch("/api/auth/vrc/me").catch(() => ({ authenticated: false }))
        ]);

        this.adminAuthenticated = !!adminMe.authenticated;
        this.userAuthenticated = !!userMe.authenticated;
        this.loginUserId = userMe.loginUserId || null;
        this.usrid = userMe.usrid || "";
        this.displayName = userMe.displayName || "";

        if (this.adminAuthenticated) {
          role = "admin";
        } else if (this.userAuthenticated) {
          role = "user";
        }
      } catch (_error) {
        this.adminAuthenticated = false;
        this.userAuthenticated = false;
        this.loginUserId = null;
        this.usrid = "";
        this.displayName = "";
      }
      this.role = role;
      this.checked = true;
      return this.authenticated;
    },
    async adminLogin(password) {
      await apiFetch("/api/admin/login", {
        method: "POST",
        body: { password }
      });
      await this.check();
    },
    async startVrcLogin(username, password) {
      const res = await apiFetch("/api/auth/vrc/login/start", {
        method: "POST",
        body: { username, password }
      });
      if (res?.ok && !res?.requiresTwoFactor && res?.loginUser) {
        this.applyUserSession(res.loginUser);
      }
      return res;
    },
    async verifyVrcLogin(flowId, method, code) {
      const res = await apiFetch("/api/auth/vrc/login/verify", {
        method: "POST",
        body: { flowId, method, code }
      });
      if (res?.ok && res?.loginUser) {
        this.applyUserSession(res.loginUser);
      }
      return res;
    },
    async logoutAdmin() {
      await apiFetch("/api/admin/logout", { method: "POST" });
      await this.check();
    },
    async logoutUser() {
      await apiFetch("/api/auth/vrc/logout", { method: "POST" });
      await this.check();
    },
    async logoutAll() {
      await Promise.all([
        apiFetch("/api/admin/logout", { method: "POST" }).catch(() => null),
        apiFetch("/api/auth/vrc/logout", { method: "POST" }).catch(() => null)
      ]);
      this.adminAuthenticated = false;
      this.userAuthenticated = false;
      this.loginUserId = null;
      this.usrid = "";
      this.displayName = "";
      this.role = "";
      this.checked = true;
      return this.authenticated;
    }
  }
});
