import { createRouter, createWebHistory } from 'vue-router'

const Home = () => import('../views/Home.vue')
const Review = () => import('../views/Review.vue')
const QnA = () => import('../views/QnA.vue')
const Settings = () => import('../views/Settings.vue')
const Rules = () => import('../views/Rules.vue')

const routes = [
  {
    path: '/',
    name: 'Home',
    component: Home
  },
  {
    path: '/review',
    name: 'Review',
    component: Review
  },
  {
    path: '/history',
    redirect: '/'
  },
  {
    path: '/qna',
    name: 'QnA',
    component: QnA
  },
  {
    path: '/settings',
    name: 'Settings',
    component: Settings
  },
  {
    path: '/rules',
    name: 'Rules',
    component: Rules
  }
]

const router = createRouter({
  history: createWebHistory(process.env.BASE_URL),
  routes
})

export default router 
