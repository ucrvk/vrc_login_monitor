<template>
  <div class="dashboard-page">
    <div class="top-bar">
      <div>
        <h2>VRChat Login Monitor Dashboard</h2>
        <p class="sub">
          当前角色:
          <el-tag :type="auth.isAdmin ? 'danger' : 'info'">{{ auth.isAdmin ? "管理员" : "用户" }}</el-tag>
          监控状态:
          <el-tag :type="systemStatus.monitoringStarted ? 'success' : 'warning'">
            {{ systemStatus.monitoringStarted ? "运行中" : "未启动" }}
          </el-tag>
          <span v-if="systemStatus.activeTokenTail" class="token-tail">token 尾号: {{ systemStatus.activeTokenTail }}</span>
        </p>
      </div>
      <div class="top-actions">
        <el-button @click="reloadAll" :loading="loading">刷新</el-button>
        <el-button type="danger" plain @click="logout">退出登录</el-button>
      </div>
    </div>

    <el-row :gutter="16">
      <el-col :xs="24" :md="7">
        <el-card class="panel">
          <template #header>
            <div class="panel-header">
              <span>loginUser</span>
            </div>
          </template>
          <el-empty v-if="users.length === 0" description="暂无 loginUser" />
          <el-menu v-else :default-active="String(selectedUserId || '')" @select="onSelectUser" class="menu">
            <el-menu-item v-for="u in users" :key="u.id" :index="String(u.id)">
              {{ u.displayName || "Pending User" }} ({{ u.usrid || "pending" }})
            </el-menu-item>
          </el-menu>
        </el-card>

        <el-card class="panel">
          <template #header>
            <div class="panel-header">
              <span>destUser（当前 loginUser 的好友实时列表）</span>
              <el-button size="small" @click="loadDestUsers" :loading="loadingDestUsers">刷新好友</el-button>
            </div>
          </template>
          <el-table :data="destUsers" size="small" height="240">
            <el-table-column prop="displayName" label="displayName" />
            <el-table-column prop="usrid" label="usrid" />
          </el-table>
        </el-card>
      </el-col>

      <el-col :xs="24" :md="17">
        <el-card class="panel">
          <template #header>
            <span>loginUser 详情</span>
          </template>
          <el-tabs>
            <el-tab-pane label="基础信息">
              <el-descriptions :column="1" border>
                <el-descriptions-item label="userId">
                  {{ selectedUser?.usrid || "未绑定（请先设置 token 或登录）" }}
                </el-descriptions-item>
                <el-descriptions-item label="displayName">
                  {{ selectedUser?.displayName || "未绑定" }}
                </el-descriptions-item>
                <el-descriptions-item label="说明">
                  userId / displayName 由 VRC 登录成功后通过服务端 `/auth/user` 自动回填，前端不可编辑
                </el-descriptions-item>
              </el-descriptions>
            </el-tab-pane>

            <el-tab-pane label="订阅规则">
              <div class="table-actions">
                <el-button size="small" @click="addSubscription">新增规则</el-button>
              </div>
              <el-table :data="subscriptions" border>
                <el-table-column label="事件类型" min-width="180">
                  <template #default="{ row }">
                    <el-select v-model="row.eventType" style="width: 100%" @change="onSubscriptionEventTypeChange(row)">
                      <el-option v-for="e in meta.eventTypes" :key="e" :label="e" :value="e" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column label="destUser" min-width="250">
                  <template #default="{ row }">
                    <el-select
                      v-model="row.destUsrid"
                      style="width: 100%"
                      clearable
                      filterable
                      :disabled="isAnyOnlyEvent(row.eventType)"
                    >
                      <el-option :value="null" label="全部目标用户" />
                      <el-option
                        v-for="d in destUsers"
                        :key="d.usrid"
                        :value="d.usrid"
                        :label="`${d.displayName} (${d.usrid})`"
                      />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column label="启用" width="90">
                  <template #default="{ row }">
                    <el-switch v-model="row.enabled" />
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="90">
                  <template #default="{ $index }">
                    <el-button text type="danger" @click="subscriptions.splice($index, 1)">删除</el-button>
                  </template>
                </el-table-column>
              </el-table>
              <div class="table-actions">
                <el-button type="primary" @click="saveSubscriptions" :loading="savingSubscriptions">保存订阅</el-button>
              </div>
            </el-tab-pane>

            <el-tab-pane label="通知渠道">
              <el-form label-width="120px">
                <el-form-item label="通知 Token">
                  <div class="notify-row">
                    <el-input
                      v-model="notifyToken"
                      placeholder="请输入通知 token（仅支持 serverchanV3）"
                    />
                    <el-button plain @click="testNotify" :loading="testingNotify">测试</el-button>
                  </div>
                </el-form-item>
                <el-form-item>
                  <div>
                    <el-button type="primary" @click="saveNotify" :loading="savingNotify">保存通知 token</el-button>
                  </div>
                </el-form-item>
              </el-form>
            </el-tab-pane>

            <el-tab-pane label="Token">
              <el-form label-width="120px">
                <el-form-item label="token">
                  <div class="token-row">
                    <el-input v-model="tokenInput" type="textarea" :rows="3" readonly />
                    <div class="token-actions">
                      <el-button type="success" plain @click="openLoginDialog">重新登录获取 token</el-button>
                    </div>
                  </div>
                </el-form-item>
              </el-form>
              <el-descriptions border :column="1" style="margin-top: 16px">
                <el-descriptions-item label="是否有效">
                  <el-tag :type="loginState.isTokenValid ? 'success' : 'danger'">
                    {{ loginState.isTokenValid ? "有效" : "无效" }}
                  </el-tag>
                </el-descriptions-item>
                <el-descriptions-item label="最近验证时间">
                  {{ formatTime(loginState.lastVerifiedAt) }}
                </el-descriptions-item>
                <el-descriptions-item label="最近错误">
                  {{ loginState.lastError || "-" }}
                </el-descriptions-item>
              </el-descriptions>
            </el-tab-pane>
          </el-tabs>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="loginDialog.visible" title="服务端登录获取 token" width="520px">
      <template v-if="!loginDialog.requiresTwoFactor">
        <el-form label-width="100px">
          <el-form-item label="用户名/邮箱">
            <el-input v-model="loginDialog.username" />
          </el-form-item>
          <el-form-item label="密码">
            <el-input v-model="loginDialog.password" type="password" show-password />
          </el-form-item>
        </el-form>
      </template>
      <template v-else>
        <el-form label-width="110px">
          <el-form-item label="验证方式">
            <el-select v-model="loginDialog.factorMethod" style="width: 100%">
              <el-option v-for="m in loginDialog.methods" :key="m" :value="m" :label="m" />
            </el-select>
          </el-form-item>
          <el-form-item label="验证码">
            <el-input v-model="loginDialog.factorCode" placeholder="输入 OTP/TOTP/Email OTP" />
          </el-form-item>
        </el-form>
      </template>

      <template #footer>
        <el-button @click="loginDialog.visible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="loginDialog.loading"
          @click="loginDialog.requiresTwoFactor ? submitLoginFactor() : submitLoginPassword()"
        >
          {{ loginDialog.requiresTwoFactor ? "提交验证码" : "下一步" }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiFetch } from "../api/http";
import { useAuthStore } from "../stores/auth";

const router = useRouter();
const auth = useAuthStore();

const loading = ref(false);
const loadingDestUsers = ref(false);
const savingSubscriptions = ref(false);
const savingNotify = ref(false);
const testingNotify = ref(false);

const users = ref([]);
const selectedUserId = ref(null);
const destUsers = ref([]);

const meta = ref({
  eventTypes: ["friend-online", "friend-offline", "friend-location"]
});

const systemStatus = ref({
  monitoringStarted: false,
  activeUserId: null,
  activeTokenTail: ""
});

const subscriptions = ref([]);
const notifyToken = ref("");
const tokenInput = ref("");
const loginState = ref({
  isTokenValid: false,
  lastVerifiedAt: null,
  lastError: ""
});

const loginDialog = reactive({
  visible: false,
  loading: false,
  username: "",
  password: "",
  requiresTwoFactor: false,
  flowId: "",
  methods: [],
  factorMethod: "",
  factorCode: ""
});

const selectedUser = computed(() => users.value.find((u) => u.id === selectedUserId.value) || null);

function formatTime(ts) {
  if (!ts) {
    return "-";
  }
  return new Date(ts).toLocaleString();
}

function patchEditorBySelectedUser() {
  const user = selectedUser.value;
  if (!user) {
    subscriptions.value = [];
    notifyToken.value = "";
    tokenInput.value = "";
    loginState.value = {
      isTokenValid: false,
      lastVerifiedAt: null,
      lastError: ""
    };
    return;
  }

  subscriptions.value = (user.subscriptions || []).map((s) => ({
    eventType: s.eventType,
    destUsrid: s.destUsrid ?? null,
    enabled: !!s.enabled
  }));

  notifyToken.value = (user.channels && user.channels[0] && user.channels[0].token) || "";

  tokenInput.value = user.loginState?.token || "";
  loginState.value = {
    isTokenValid: !!user.loginState?.isTokenValid,
    lastVerifiedAt: user.loginState?.lastVerifiedAt || null,
    lastError: user.loginState?.lastError || ""
  };
}

async function reloadAll() {
  loading.value = true;
  try {
    const [usersRes, metaRes, statusRes] = await Promise.all([
      apiFetch("/api/users"),
      apiFetch("/api/meta"),
      apiFetch("/api/system/status")
    ]);

    users.value = usersRes.users || [];
    meta.value = {
      eventTypes: metaRes.eventTypes || meta.value.eventTypes
    };
    systemStatus.value = statusRes;

    if (!selectedUserId.value && users.value.length > 0) {
      selectedUserId.value = users.value[0].id;
    } else if (selectedUserId.value && !users.value.some((u) => u.id === selectedUserId.value)) {
      selectedUserId.value = users.value[0]?.id || null;
    }

    patchEditorBySelectedUser();
    await loadDestUsers();
  } catch (error) {
    ElMessage.error(error.message || "加载失败");
  } finally {
    loading.value = false;
  }
}

async function onSelectUser(userId) {
  selectedUserId.value = Number(userId);
  patchEditorBySelectedUser();
  await loadDestUsers();
}

async function loadDestUsers() {
  if (!selectedUserId.value) {
    destUsers.value = [];
    return;
  }
  loadingDestUsers.value = true;
  try {
    const res = await apiFetch(`/api/users/${selectedUserId.value}/friends`);
    destUsers.value = res.destUsers || [];
  } catch (error) {
    destUsers.value = [];
    ElMessage.error(error.message || "加载好友列表失败");
  } finally {
    loadingDestUsers.value = false;
  }
}

function addSubscription() {
  const defaultEventType = meta.value.eventTypes[0] || "friend-online";
  subscriptions.value.push({
    eventType: defaultEventType,
    destUsrid: null,
    enabled: true
  });
}

function isAnyOnlyEvent(eventType) {
  return eventType === "friend-add" || eventType === "friend-delete";
}

function onSubscriptionEventTypeChange(row) {
  if (!row) {
    return;
  }
  if (isAnyOnlyEvent(row.eventType)) {
    row.destUsrid = null;
  }
}

async function saveSubscriptions() {
  if (!selectedUserId.value) {
    ElMessage.warning("当前没有可用 loginUser，请先完成 VRC 登录");
    return;
  }
  savingSubscriptions.value = true;
  try {
    const normalized = subscriptions.value.map((row) => ({
      ...row,
      destUsrid: isAnyOnlyEvent(row.eventType) ? null : row.destUsrid ?? null
    }));
    await apiFetch(`/api/users/${selectedUserId.value}/subscriptions`, {
      method: "POST",
      body: { subscriptions: normalized }
    });
    ElMessage.success("订阅已保存");
    await reloadAll();
  } catch (error) {
    ElMessage.error(error.message || "保存订阅失败");
  } finally {
    savingSubscriptions.value = false;
  }
}

async function saveNotify() {
  if (!selectedUserId.value) {
    ElMessage.warning("当前没有可用 loginUser，请先完成 VRC 登录");
    return;
  }

  savingNotify.value = true;
  try {
    await apiFetch(`/api/users/${selectedUserId.value}/channels`, {
      method: "POST",
      body: { token: notifyToken.value }
    });
    ElMessage.success("通知 token 已保存");
    await reloadAll();
  } catch (error) {
    ElMessage.error(error.message || "保存通知 token 失败");
  } finally {
    savingNotify.value = false;
  }
}

async function testNotify() {
  if (!selectedUserId.value) {
    ElMessage.warning("当前没有可用 loginUser，请先完成 VRC 登录");
    return;
  }

  testingNotify.value = true;
  try {
    const res = await apiFetch(`/api/users/${selectedUserId.value}/channels/test`, {
      method: "POST",
      body: { token: notifyToken.value }
    });
    if (res.ok) {
      ElMessage.success("测试通知发送成功");
    } else {
      ElMessage.error(res.error || "测试通知发送失败");
    }
  } catch (error) {
    ElMessage.error(error.message || "测试通知发送失败");
  } finally {
    testingNotify.value = false;
  }
}

function resetLoginDialog() {
  loginDialog.username = "";
  loginDialog.password = "";
  loginDialog.requiresTwoFactor = false;
  loginDialog.flowId = "";
  loginDialog.methods = [];
  loginDialog.factorMethod = "";
  loginDialog.factorCode = "";
}

function openLoginDialog() {
  resetLoginDialog();
  loginDialog.visible = true;
}

async function submitLoginPassword() {
  loginDialog.loading = true;
  try {
    const res = await apiFetch(`/api/auth/vrc/login/start`, {
      method: "POST",
      body: {
        username: loginDialog.username,
        password: loginDialog.password
      }
    });

    if (!res.ok) {
      ElMessage.error(res.error || "登录失败");
      return;
    }

    if (res.requiresTwoFactor) {
      loginDialog.requiresTwoFactor = true;
      loginDialog.flowId = res.flowId;
      loginDialog.methods = Array.isArray(res.methods) ? res.methods : [];
      loginDialog.factorMethod = loginDialog.methods[0] || "totp";
      ElMessage.info("请继续输入二次验证码");
      return;
    }

    if (res.token) {
      tokenInput.value = res.token;
    }
    await auth.check();
    ElMessage.success("登录成功，token 已回填");
    loginDialog.visible = false;
    await reloadAll();
  } catch (error) {
    ElMessage.error(error.message || "登录失败");
  } finally {
    loginDialog.loading = false;
  }
}

async function submitLoginFactor() {
  loginDialog.loading = true;
  try {
    const res = await apiFetch(`/api/auth/vrc/login/verify`, {
      method: "POST",
      body: {
        flowId: loginDialog.flowId,
        method: loginDialog.factorMethod,
        code: loginDialog.factorCode
      }
    });
    if (!res.ok) {
      ElMessage.error(res.error || "验证码校验失败");
      return;
    }
    if (res.token) {
      tokenInput.value = res.token;
    }
    await auth.check();
    ElMessage.success("登录成功，token 已回填");
    loginDialog.visible = false;
    await reloadAll();
  } catch (error) {
    ElMessage.error(error.message || "验证码校验失败");
  } finally {
    loginDialog.loading = false;
  }
}

async function logout() {
  await auth.logoutAll();
  await router.replace("/login");
}

onMounted(async () => {
  await reloadAll();
});
</script>

<style scoped>
.dashboard-page {
  min-height: 100vh;
  padding: 16px;
  background: linear-gradient(160deg, #f4fbff 0%, #f4fff5 100%);
}

.top-bar {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 16px;
}

.top-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.sub {
  margin: 8px 0 0;
  color: #4a4a4a;
  display: flex;
  align-items: center;
  gap: 8px;
}

.token-tail {
  font-size: 12px;
  color: #666;
}

.panel {
  margin-bottom: 16px;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.menu {
  border-right: none;
}

.table-actions {
  margin: 10px 0;
}

.notify-row {
  display: flex;
  gap: 8px;
  width: 100%;
}

.notify-row :deep(.el-input) {
  flex: 1;
}

.token-row {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 12px;
  align-items: start;
}

.token-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

@media (max-width: 768px) {
  .top-bar {
    flex-direction: column;
  }

  .token-row {
    grid-template-columns: 1fr;
  }

  .token-actions {
    flex-direction: row;
  }
}
</style>
