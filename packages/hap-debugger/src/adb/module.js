/*
 * Copyright (c) 2021-present, the hapjs-platform Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import devicesEmitter from 'adb-devices-emitter'
import adbCommander from 'adb-commander'

import {
  colorconsole,
  globalConfig,
  recordClient,
  removeClientBySn
} from '@hap-toolkit/shared-utils'
import debuglog from './debuglog'

const REMOTE_REVERSE_PORT = 12306
const REMOTE_UP_FORWARD_PORT = 39517

/**
 * ADB Modules
 */
class ADBModule {
  /**
   * ADBModule constructor
   * @param option
   * @param option.localReversePort  {number} adb reverse命令使用的端口
   */
  constructor(option) {
    this.option = option
    // 当前连接的设备列表 sn: { upForwardPortPair:[localPort, remotePort], wsPortPair[localPort, remotePort] }
    this.currentDeviceMap = new Map()
    // 用来记录所有当前连接和已拔出的设备列表
    this.cachedDeviceMap = new Map()
    this.DEBUG = (process.env.NODE_DEBUG || '').split(',').includes('adb')
    // 记录localUpForwardPort(自增)的端口号, 初始值等于REMOTE_UP_FORWARD_PORT
    this._localUpForwardPort = REMOTE_UP_FORWARD_PORT
    this.commander = adbCommander
    this.devicesEmitter = devicesEmitter
    this._lastPromise = null

    this.emulators = new Map()
    // reverse 自愈巡检定时器：周期性校验每台设备的 adb reverse 规则是否仍然存在，缺失则补建
    this._reverseWatchdogTimer = null
    // 防止一次巡检尚未结束时又触发下一次巡检，避免并发堆积
    this._reverseWatchdogRunning = false
    // 按设备 sn 维度串行化 reverse 相关操作，避免同一台设备上 adb 命令交错导致状态不一致
    this._reverseSerialQueue = new Map()

    this.init()
  }

  /**
   * 注册事件， 开始查询设备
   */
  init() {
    debuglog(`init(): start`)
    this.devicesEmitter.addEventListener('deviceAdded', (event) => {
      this._listen(event, this.onDeviceAdded.bind(this))
    })
    this.devicesEmitter.addEventListener('deviceRemoved', (event) => {
      this._listen(event, this.onDeviceRemoved.bind(this))
    })
    this.devicesEmitter.start()
    this.startReverseWatchdog()
  }

  /**
   * 确保队列式的调用顺序
   * @private
   */
  _listen(event, callback) {
    if (!this._lastPromise) {
      this._lastPromise = callback(event)
    } else {
      this._lastPromise = this._lastPromise.then(
        () => {
          return callback(event)
        },
        () => {
          return callback(event)
        }
      )
    }
  }

  /**
   * 取得一个_localUpForwardPort端口数字
   * @private
   */
  _getNextLocalForwardPort() {
    return this._localUpForwardPort++
  }

  /**
   * 处理每个新增设备
   * @desc
   * 为每一个设备执行以下操作：
   * 1. adb reverse tcp:${localReversePort} tcp:REMOTE_REVERSE_PORT,
   * 2. adb forward tcp:${localUpForwardPort} tcp:REMOTE_UP_FORWARD_PORT;
   * 3. 如果cachedDeviceList中存在当前新增设备, 且状态为已断开, 检查该设备是否
   * 已有wsForwardPort端口记录信息, 有则执行adb forward tcp:${wsPair[0]} tcp:${wsPair[1]};
   * 4. 为currentList中新增当前设备;
   * @param event
   * @param event.sn 设备序列号
   */
  async onDeviceAdded(event) {
    const { sn } = event
    colorconsole.info(`### App Server ### 设备"${sn}"被连入`)
    const { result } = await this.commander.getProp(sn)
    if (result) {
      this.emulators.set(result.trim(), sn)
    }
    const localReversePort = this.option.localReversePort
    // 建立reverse设定
    const reverseResult = await this.establishADBProxyLink('reverse', [
      sn,
      localReversePort,
      REMOTE_REVERSE_PORT
    ])
    if (reverseResult.err) {
      colorconsole.error(
        `### App Server ### onDeviceAdded(): (${sn})建立adb reverse失败(local port: ${localReversePort}, remote port: ${REMOTE_REVERSE_PORT})`
      )
      return
    }

    // 检查cachedDeviceList中的设备状况
    let currentDevice = this.cachedDeviceMap.get(sn)
    debuglog(
      `onDeviceAdded():(${sn})\ncachedDevice:\t${JSON.stringify(
        currentDevice
      )}\ncachedDeviceList:\t${JSON.stringify(Array.from(this.cachedDeviceMap.entries()))}`
    )

    // 建立forward update port设定
    if (!currentDevice || !currentDevice.upForwardPortPair) {
      currentDevice = {
        upForwardPortPair: [this._getNextLocalForwardPort(), REMOTE_UP_FORWARD_PORT]
      }
    }
    const upForwardResult = await this.establishADBProxyLink(
      'forward',
      [sn].concat(currentDevice.upForwardPortPair)
    )
    if (upForwardResult.err) {
      colorconsole.error(
        `### App Server ### onDeviceAdded(): (${sn})建立adb forward失败(local port: ${currentDevice.upForwardPortPair[0]}, remote port: ${currentDevice.upForwardPortPair[1]}) `
      )
      return
    }

    // 如果有记录的调试端口 为调试web socket建立forward
    if (currentDevice.wsPortPair) {
      const debugForwardResult = await this.establishADBProxyLink('forward', [
        sn,
        currentDevice.wsPortPair[0],
        currentDevice.wsPortPair[1]
      ])
      if (debugForwardResult.err) {
        colorconsole.warn(
          `### App Server ### onDeviceAdded():(${sn}) 建立adb forward失败(local port: ${currentDevice.wsPortPair[0]}, remote port: ${currentDevice.wsPortPair[1]})`
        )
        currentDevice.wsPortPair = undefined
      }
    }

    // 记录当前设备
    this.currentDeviceMap.set(sn, currentDevice)
    this.cachedDeviceMap.set(sn, currentDevice)
    // 记录发送update http请求需要的ip和端口
    const remote2local = {}
    remote2local[currentDevice.upForwardPortPair[1]] = currentDevice.upForwardPortPair[0]
    await this._writeClientLogFile({
      sn,
      ip: `127.0.0.1`,
      port: currentDevice.upForwardPortPair[0],
      remote2local
    })
    debuglog(`onDeviceAdded():(${sn}) end`)
    // 增加设备连接检测
    this.onCheckDeviceReverse(event)
  }

  async getForwardPort(client, remotePort) {
    let remote2local = client.remote2local
    if (!remote2local) return client.port

    let port = remote2local[remotePort]
    if (!port) {
      // addForwardPort
      port = await this.addForwardPort(client, remotePort)
    }
    return port
  }

  async addForwardPort(client, remotePort) {
    const port = this._getNextLocalForwardPort()
    debuglog(
      `addForwardPort():(${client.sn}) (local port: ${port}, remote port: ${remotePort}) start`
    )
    const upForwardResult = await this.establishADBProxyLink(
      'forward',
      [client.sn].concat([port, remotePort])
    )
    if (upForwardResult.err) {
      colorconsole.error(
        `### App Server ### addForwardPort(): (${client.sn})建立adb forward失败(local port: ${port}, remote port: ${remotePort}) `
      )
      return
    }
    client.remote2local[remotePort] = port
    await this._writeClientLogFile(client)
    debuglog(
      `addForwardPort():(${client.sn}) (local port: ${port}, remote port: ${remotePort}) end`
    )
    return port
  }

  /**
   * 设备连接检测，用于检查当前窗口端口是否连接手机调试器
   */
  onCheckDeviceReverse(event) {
    const { sn } = event
    try {
      setTimeout(async () => {
        // 统一走“检查 + 修复”的逻辑：如果 reverse 已经丢失（例如设备快速拔插导致规则被清空），这里会自动补建
        await this._ensureReverseForDevice(sn, { log: true })
      }, 6000)
    } catch (err) {
      colorconsole.error(`### App Server ### onCheckDeviceReverse(): adb reverse连接检测失败`)
    }
  }

  startReverseWatchdog() {
    // 避免重复启动
    if (this._reverseWatchdogTimer) return
    // 2s 进行一次 reverse 的自检
    const intervalMs = Number(this.option.reverseWatchdogIntervalMs || 2000)
    this._reverseWatchdogTimer = setInterval(() => {
      this._runReverseWatchdogTick()
    }, intervalMs)
    if (this._reverseWatchdogTimer && typeof this._reverseWatchdogTimer.unref === 'function') {
      this._reverseWatchdogTimer.unref()
    }
  }

  stopReverseWatchdog() {
    if (this._reverseWatchdogTimer) {
      clearInterval(this._reverseWatchdogTimer)
      this._reverseWatchdogTimer = null
    }
    this._reverseWatchdogRunning = false
    this._reverseSerialQueue.clear()
  }

  _runReverseWatchdogTick() {
    // 上一轮还在跑就跳过，避免并发叠加导致 adb 压力过大
    if (this._reverseWatchdogRunning) return
    this._reverseWatchdogRunning = true
    ;(async () => {
      // 这里用的是 currentDeviceMap，依赖 adb-commander 库
      // 后续如果有问题，这里可以改成实时 adb devices 去查设备列表
      const serials = Array.from(this.currentDeviceMap.keys())
      if (serials.length === 0) return
      // 多设备允许并发，但同一 sn 内部仍然会串行（见 _enqueueReverseTask）
      const concurrency = Number(this.option.reverseWatchdogConcurrency || 3)
      await this._mapWithConcurrency(serials, concurrency, (sn) => {
        return this._enqueueReverseTask(sn, () => this._ensureReverseForDevice(sn))
      })
    })()
      .catch((err) => {
        debuglog(`reverse watchdog tick failed: ${err && err.message ? err.message : String(err)}`)
      })
      .finally(() => {
        this._reverseWatchdogRunning = false
      })
  }

  _enqueueReverseTask(sn, task) {
    // 对同一个 sn 的任务按 promise 链串起来：保证同一设备上的 adb reverse --list / reverse 操作不会交错执行
    const previous = this._reverseSerialQueue.get(sn) || Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => task())
      .finally(() => {
        if (this._reverseSerialQueue.get(sn) === next) {
          this._reverseSerialQueue.delete(sn)
        }
      })
    this._reverseSerialQueue.set(sn, next)
    return next
  }

  async _mapWithConcurrency(items, concurrency, iterator) {
    // 简单并发池：最多同时执行 limit 个 iterator
    const limit = Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 1
    const executing = new Set()
    const results = []

    for (const item of items) {
      const p = Promise.resolve().then(() => iterator(item))
      results.push(p)
      executing.add(p)
      const cleanup = () => executing.delete(p)
      p.then(cleanup, cleanup)
      if (executing.size >= limit) {
        await Promise.race(executing)
      }
    }

    return Promise.allSettled(results)
  }

  _reverseListMatchesExpected(reverseListOutput, localReversePort, remoteReversePort) {
    // adb reverse --list 的典型输出每行类似：
    // tcp:12345 tcp:12306
    if (!reverseListOutput) return false
    const expectedLocal = Number(localReversePort)
    const expectedRemote = Number(remoteReversePort)
    const lines = String(reverseListOutput)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    for (const line of lines) {
      const match = line.match(/^tcp:(\d+)\s+tcp:(\d+)$/)
      if (!match) continue
      const a = Number(match[1])
      const b = Number(match[2])
      if (
        (a === expectedLocal && b === expectedRemote) ||
        (a === expectedRemote && b === expectedLocal)
      ) {
        return true
      }
    }

    const localStr = String(expectedLocal)
    const remoteStr = String(expectedRemote)
    return lines.some((line) => line.includes(localStr) && line.includes(remoteStr))
  }

  async _ensureReverseForDevice(sn, { log = false } = {}) {
    const localReversePort = this.option.localReversePort
    let reverseListOutput = ''

    try {
      // 使用 -s sn 做到按设备维度校验，支持多设备同时连接
      const { result } = await this.commander._commandFactory(`adb -s ${sn} reverse --list`)
      reverseListOutput = result || ''
    } catch (err) {
      reverseListOutput = ''
    }

    const ok = this._reverseListMatchesExpected(
      reverseListOutput,
      localReversePort,
      REMOTE_REVERSE_PORT
    )
    if (ok) {
      if (log) {
        colorconsole.info(`### App Server ### (${sn}) adb reverse已就绪`)
      }
      return { ok: true }
    }

    // reverse 缺失：执行一次补建
    const reverseResult = await this.establishADBProxyLink('reverse', [
      sn,
      localReversePort,
      REMOTE_REVERSE_PORT
    ])

    if (reverseResult.err) {
      if (log) {
        colorconsole.error(
          `### App Server ### (${sn}) 建立adb reverse失败(local port: ${localReversePort}, remote port: ${REMOTE_REVERSE_PORT})`
        )
      }
      return { ok: false, err: reverseResult.err }
    }

    if (log) {
      colorconsole.info(
        `### App Server ### (${sn}) 已修复adb reverse(local port: ${localReversePort}, remote port: ${REMOTE_REVERSE_PORT})`
      )
    }

    return { ok: true, repaired: true }
  }
  /**
   * 移除设备事件
   */
  async onDeviceRemoved(event) {
    const { sn } = event
    colorconsole.info(`### App Server ### 手机设备(${sn})被拔出`)
    this.currentDeviceMap.delete(sn)
    // 避免该设备后续队列中残留任务引用
    this._reverseSerialQueue.delete(sn)
    if (this.DEBUG) {
      debuglog(
        `deviceRemoved():(${sn}) cachedDeviceList: ${JSON.stringify(
          Array.from(this.cachedDeviceMap.entries())
        )}`
      )
      await this.commander.print(`adb -s ${sn} reverse --list`)
      await this.commander.print(`adb -s ${sn} forward --list`)
    }
    await this._removeItemFromClientLogFile(sn)
    debuglog(`deviceRemoved():(${sn}) end`)
  }

  /**
   * 记录一条端口映射条目
   */
  async _writeClientLogFile(newClient) {
    try {
      const { clientRecordPath } = globalConfig
      recordClient(clientRecordPath, newClient, (msg) => {
        debuglog(msg)
      })
    } catch (err) {
      colorconsole.error(
        `### App Server ### writeClientLogFile(): 写入hap-toolkit-client-records.json文件出错: ${err.message}`
      )
    }
  }

  /**
   * 从端口映射记录文件中移除一个条目
   */
  async _removeItemFromClientLogFile(sn) {
    try {
      const { clientRecordPath } = globalConfig
      removeClientBySn(clientRecordPath, sn, (msg) => {
        debuglog(msg)
      })
    } catch (err) {
      colorconsole.error(
        `### App Server ### _removeItemFromClientLogFile(): 移除hap-toolkit-client-records.json设备信息出错： ${err.message}`
      )
    }
  }

  /**
   * 建立Websocket连接的端口映射
   * @param sn 设备序列号
   * @param remoteWsPort Websocket连接的远程端口号
   * @returns {Promise.<{ localWsPort } | { err }>}
   */
  async forwardForWsChannel(sn, remoteWsPort) {
    let device = this.currentDeviceMap.get(sn)
    // 暂时localWsPort与remoteWsPort一样;
    const localWsPort = remoteWsPort

    if (!device) {
      const realSN = this.emulators.get(sn)
      colorconsole.warn(`### App Server ### 通过（${sn}）查找到设备${realSN}`)
      device = this.currentDeviceMap.get(realSN)
      if (device) {
        sn = realSN
      }
    }

    if (!device) {
      colorconsole.error(`### App Server ### 获取(${sn})设备信息失败`)
      return { localWsPort }
    }
    const wsPortPair = device.wsPortPair

    // 若之前不存在端口， 说明是第一次连接，否则可以不必设定
    if (wsPortPair && wsPortPair[0] === localWsPort && wsPortPair[1] === remoteWsPort) {
      return { localWsPort }
    }
    const { err } = await this.establishADBProxyLink('forward', [sn, localWsPort, remoteWsPort])
    if (err) {
      colorconsole.error(`### AppApp Server ### forwardForWsChannel(): 创建WebSocket端口映射失败`)
      device.wsPortPair = undefined
      return { err }
    }
    device.wsPortPair = [localWsPort, remoteWsPort]
    return { localWsPort }
  }

  /**
   * 建立adb reverse/forward通道
   * @param type {string} "reverse"|"forward"
   * @param args {array}  建立reverse/forward通道所需的参数. e.g. [sn, localPort, devicePort]
   */
  async establishADBProxyLink(type, args) {
    const result = await this.commander[type](...args)

    if (this.DEBUG) {
      debuglog(
        `establishADBReverseLink(): (${args[0]}) adb ${type} setup result: ${JSON.stringify(
          result
        )}`
      )
      await this.commander.print(`adb -s ${args[0]} ${type} --list`)
    }
    return result
  }

  _stop() {
    colorconsole.log(`### ADB stop`)
    // 停止定时巡检，避免进程无法退出或持续刷 adb
    this.stopReverseWatchdog()
    this.devicesEmitter.stop()
  }
}

export default ADBModule
