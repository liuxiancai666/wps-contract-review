<template>
  <div class="header-component">
    <img src="/asserts/logo_v2.png" alt="牛马在线" class="logo">
    <h1>牛马在线</h1>
  </div>
</template>

<script>
export default {
  name: 'HeaderComponent',
};
</script>

<style scoped>
.header-component {
  display: flex;
  align-items: center;
  padding: 10px 20px;
  background-color: #111111;
  color: white;
}

.logo {
  height: 40px;
  margin-right: 20px;
}

h1 {
  margin: 0;
  font-size: 20px;
}
</style>
