

#### 默认启动
```shell
docker-compose -p docker_frpcmgrd up --force-recreate --detach
```

#### 指定启动文件
```shell
docker-compose -f ./docker-compose.yml -p docker_frpcmgrd up --force-recreate --detach
```

#### 指定启动文件-强制更新
```shell
docker-compose -f ./docker-compose.yml -p docker_frpcmgrd up --force-recreate --detach --pull always
```

#### 启用组网 / 虚拟网络 (vnet · 实验性)
vnet 需要创建 TUN 网卡（CAP_NET_ADMIN + `/dev/net/tun`），用专用 compose 变体（含 `cap_add: [NET_ADMIN]`、`devices: /dev/net/tun`、`FRPCMGR_RUN_AS_ROOT=1`，以 root 运行）。仅 Linux 宿主可用。
```shell
docker-compose -f ./docker-compose.vnet.yml -p docker_frpcmgrd up --force-recreate --detach
```
随后在网页后台「常规配置 → 组网 (VNet)」开启并配置，详见 [docs/API.zh-CN.md §2.12](../docs/API.zh-CN.md)。
