import { createRouter, createWebHistory } from 'vue-router'

const Home = () => import('../views/Home.vue')
const Review = () => import('../views/Review.vue')
const QnA = () => import('../views/QnA.vue')
const Settings = () => import('../views/Settings.vue')
const Rules = () => import('../views/Rules.vue')
const Login = () => import('../views/Login.vue')
const Admin = () => import('../views/Admin.vue')

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: Login,
    meta: { guest: true },
  },
  {
    path: '/',
    name: 'Home',
    component: Home,
    meta: { requiresAuth: true },
  },
  {
    path: '/review',
    name: 'Review',
    component: Review,
    meta: { requiresAuth: true },
  },
  {
    path: '/history',
    redirect: '/',
  },
  {
    path: '/qna',
    name: 'QnA',
    component: QnA,
    meta: { requiresAuth: true },
  },
  {
    path: '/settings',
    name: 'Settings',
    component: Settings,
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    path: '/rules',
    name: 'Rules',
    component: Rules,
    meta: { requiresAuth: true },
  },
  {
    path: '/admin',
    name: 'Admin',
    component: Admin,
    meta: { requiresAuth: true, requiresAdmin: true },
  },
]

const router = createRouter({
  history: createWebHistory(process.env.BASE_URL),
  routes,
})

// 路由守卫
router.beforeEach(async (to, from, next) => {
  // 动态导入 useAuth（避免循环依赖）
  const { useAuth } = await import('../composables/useAuth')
  const { isLoggedIn, isAdmin } = useAuth()

  if (to.meta.requiresAuth && !isLoggedIn.value) {
    next({ path: '/login', query: { redirect: to.fullPath } })
    return
  }

  if (to.meta.requiresAdmin && !isAdmin.value) {
    next({ path: '/' })
    return
  }

  // 已登录用户访问登录页 → 跳首页
  if (to.meta.guest && isLoggedIn.value) {
    next({ path: '/' })
    return
  }

  next()
})

export default router
