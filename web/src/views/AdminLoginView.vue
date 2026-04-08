<template>
  <div class="login-page">
    <el-card class="login-card">
      <template #header>
        <div class="card-header">Dashboard 管理员登录</div>
      </template>

      <el-form @submit.prevent="submit">
        <el-form-item label="管理员密码">
          <el-input
            v-model="password"
            type="password"
            show-password
            placeholder="请输入 ADMIN_PASSWORD"
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-button type="primary" :loading="loading" @click="submit" style="width: 100%">
          登录
        </el-button>
      </el-form>

      <div class="entry-links">
        <router-link to="/login">返回 VRC 用户登录</router-link>
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
const password = ref("");
const loading = ref(false);

async function submit() {
  if (!password.value.trim()) {
    ElMessage.warning("请输入密码");
    return;
  }

  loading.value = true;
  try {
    await auth.adminLogin(password.value);
    ElMessage.success("登录成功");
    await router.replace("/dashboard");
  } catch (error) {
    ElMessage.error(error.message || "登录失败");
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
  width: 420px;
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
