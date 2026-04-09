<template>
  <div class="login-page">
    <el-card class="login-card">
      <template #header>
        <div class="card-header">VRC 账号登录</div>
      </template>

      <template v-if="!requiresTwoFactor">
        <el-form @submit.prevent="submitPassword">
          <el-form-item label="用户名/邮箱">
            <el-input v-model="username" @keyup.enter="submitPassword" />
          </el-form-item>
          <el-form-item label="密码">
            <el-input v-model="password" type="password" show-password @keyup.enter="submitPassword" />
          </el-form-item>
          <el-button type="primary" :loading="loading" @click="submitPassword" style="width: 100%">
            登录
          </el-button>
        </el-form>
      </template>

      <template v-else>
        <el-form @submit.prevent="submitFactor">
          <el-form-item label="验证方式">
            <el-select v-model="factorMethod" style="width: 100%">
              <el-option v-for="m in methods" :key="m" :value="m" :label="m" />
            </el-select>
          </el-form-item>
          <el-form-item label="验证码">
            <el-input v-model="factorCode" placeholder="输入 OTP / TOTP / Email OTP" @keyup.enter="submitFactor" />
          </el-form-item>
          <el-button type="primary" :loading="loading" @click="submitFactor" style="width: 100%">
            提交验证码
          </el-button>
          <el-button style="width: 100%; margin-top: 8px" @click="reset2FA">返回账号密码</el-button>
        </el-form>
      </template>

      <div class="entry-links">
        <router-link to="/admin/login">管理员登录入口</router-link>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "../stores/auth";

const router = useRouter();
const auth = useAuthStore();

const username = ref("");
const password = ref("");
const loading = ref(false);

const requiresTwoFactor = ref(false);
const flowId = ref("");
const methods = ref([]);
const factorMethod = ref("totp");
const factorCode = ref("");

function reset2FA() {
  requiresTwoFactor.value = false;
  flowId.value = "";
  methods.value = [];
  factorMethod.value = "totp";
  factorCode.value = "";
}

async function submitPassword() {
  if (!username.value.trim() || !password.value.trim()) {
    ElMessage.warning("请输入用户名和密码");
    return;
  }

  loading.value = true;
  try {
    const res = await auth.startVrcLogin(username.value, password.value);
    if (!res.ok) {
      ElMessage.error(res.error || "登录失败");
      return;
    }

    if (res.requiresTwoFactor) {
      requiresTwoFactor.value = true;
      flowId.value = res.flowId || "";
      methods.value = Array.isArray(res.methods) && res.methods.length ? res.methods : ["totp"];
      factorMethod.value = methods.value[0];
      ElMessage.info("请继续输入二次验证码");
      return;
    }

    ElMessage.success("登录成功");
    await router.replace("/dashboard");
  } catch (error) {
    ElMessage.error(error.message || "登录失败");
  } finally {
    loading.value = false;
  }
}

async function submitFactor() {
  if (!flowId.value || !factorCode.value.trim()) {
    ElMessage.warning("请输入验证码");
    return;
  }

  loading.value = true;
  try {
    const res = await auth.verifyVrcLogin(flowId.value, factorMethod.value, factorCode.value);
    if (!res.ok) {
      ElMessage.error(res.error || "验证码校验失败");
      return;
    }

    ElMessage.success("登录成功");
    await router.replace("/dashboard");
  } catch (error) {
    ElMessage.error(error.message || "验证码校验失败");
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: linear-gradient(140deg, #f3f7ff, #f7fff2);
}

.login-card {
  width: 460px;
  max-width: 100%;
}

.card-header {
  font-size: 18px;
  font-weight: 600;
}

.entry-links {
  margin-top: 12px;
  text-align: right;
}
</style>
