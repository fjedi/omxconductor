// tslint:disable:ordered-imports
import fs from 'fs'
import path from 'path'
import {
  defaultOptions,
  CONTROL_CHECK_INTERVAL_MS,
  CONTROL_CHECK_MAX_ATTEMPTS,
} from './defaults'
import { exec } from 'child_process'
import { EventEmitter } from 'events'

import {
  getFloat,
  getPlayStatus,
  setPosition,
  millToMicro,
  pause,
  stop,
  resume,
} from './dbus'

export enum AudioOutput {
  hdmi = 'hdmi',
  local = 'local',
  both = 'both',
}

export interface PlayerOptions {
  layer?: number
  dBusId?: string
  audioOutput?: AudioOutput
  backgroundColor?: string
  noBackgroundColor?: boolean
  loop?: boolean
}

export interface PlayerSettings {
  layer: number
  dBusId: string
  audioOutput: AudioOutput
  backgroundColor: string
  noBackgroundColor: boolean
  loop: boolean
  testModeOnly: boolean
  progressInterval: number
}

interface Trigger {
  positionMs: number
  handler: (triggeredPositionMs: number) => void
  alreadyTrigged: boolean
}

export class Player extends EventEmitter {
  private file: string
  private settings: PlayerSettings
  private positionTriggers: Trigger[]
  private disableProgressChecks: boolean
  private progressCheckIntervalTimer: NodeJS.Timer | null

  constructor(file: string, options?: PlayerOptions) {
    super()
    this.file = file
    this.settings = { ...defaultOptions, ...(options as PlayerSettings) }
    this.positionTriggers = []
    this.disableProgressChecks = false
    this.progressCheckIntervalTimer = null
  }

  getSettings = () => {
    return this.settings
  }

  enableTestMode = () => {
    this.settings.testModeOnly = true
  }

  waitForControl = () =>
    new Promise((resolve, reject) => {
      let attempts = 0
      const interval = setInterval(() => {
        attempts++
        getPlayStatus(this.settings.dBusId)
          .then((result) => {
            clearInterval(interval)
            resolve({ result, attempts })
          })
          .catch((err) => {
            if (attempts > CONTROL_CHECK_MAX_ATTEMPTS) {
              reject({ err, attempts })
            } // else ignore and try again
          })
      }, CONTROL_CHECK_INTERVAL_MS)
    })

  open = (waitOnBlack = false) =>
    new Promise((resolve, reject) => {
      const filePath = path.resolve(this.file)
      fs.stat(filePath, (err, stats) => {
        if (err) {
          reject({ filePath, err })
        } else {
          this.startOmxInstance(filePath)
            .then((command) => {
              this.emit('open', { filePath, command, playing: !waitOnBlack })
              this.waitForControl()
                .then((result) => {
                  this.emit('ready', result)
                  this.scheduleProgressCheck()
                })
                .catch((waitErr) => this.emit('error', waitErr))
              resolve({ filePath, command, playing: !waitOnBlack })
            })
            .catch((startError) => {
              reject({ filePath, err: startError })
            })
        }
      })
    })

  seekAbsolute = (positionMs: number, callback?: () => void) => {
    setPosition(this.settings.dBusId, positionMs)
      .then(() => {
        if (callback) {
          callback()
        }
      })
      .catch((err) => this.emit('error', err))
  }

  pause = (callback?: () => void) => {
    pause(this.settings.dBusId)
      .then(() => {
        if (callback) {
          callback()
        }
        this.emit('paused')
      })
      .catch((err) => this.emit('error', err))
  }

  stop = (callback?: () => void) => {
    this.stopProgressCheck()
    stop(this.settings.dBusId)
      .then(() => {
        if (callback) {
          callback()
        }
        this.emit('stopped')
      })
      .catch((err) => this.emit('error', err))
  }

  resume = (callback?: () => void) => {
    resume(this.settings.dBusId)
      .then(() => {
        if (callback) {
          callback()
        }
        this.emit('resumed')
      })
      .catch((err) => this.emit('error', err))
  }

  registerPositionTrigger = (
    positionMs: number,
    handler: (triggeredPositionMs: number) => void
  ) => {
    this.positionTriggers.push({
      positionMs,
      handler,
      alreadyTrigged: false,
    })
  }

  private startOmxInstance = (file: string) =>
    new Promise((resolve, reject) => {
      const command = `omxplayer ${settingsToArgs(file, this.settings).join(
        ' '
      )} < omxpipe${this.settings.layer}`
      if (this.settings.testModeOnly) {
        resolve({ command, testModeOnly: true })
      } else {
        exec(`mkfifo omxpipe${this.settings.layer}`, () => {
          // ignore errors, e.g. already exists
          exec(command, (err, stdout, stderr) => {
            // this block only executes when pipe is closed!
            this.emit('close', { err, stdout, stderr })
          })
          exec(`. > omxpipe${this.settings.layer}`, (err, stdout, stderr) => {
            if (err) {
              reject({ err, command })
            } else {
              resolve({ command, stdout, stderr, testModeOnly: false })
            }
          })
        })
      }
    })

  private progressCheck = () => {
    let position: number
    let duration: number
    if (this.disableProgressChecks) {
      return
    }
    getFloat(this.settings.dBusId, 'Position')
      .then((value) => {
        position = value

        return getFloat(this.settings.dBusId, 'Duration')
      })
      .then((value) => {
        duration = value
        if (this.positionTriggers.length > 0) {
          this.positionTriggers.forEach((trigger) => {
            if (
              position / millToMicro >= trigger.positionMs &&
              !trigger.alreadyTrigged
            ) {
              trigger.handler(position / millToMicro)
              trigger.alreadyTrigged = true
            }
            if (
              position / millToMicro < trigger.positionMs &&
              trigger.alreadyTrigged
            ) {
              trigger.alreadyTrigged = false // reset
            }
          })
        }
        this.emit('progress', {
          position,
          duration,
          progress: position / duration,
        })
      })
      .catch((err) => {
        if (!this.disableProgressChecks) {
          this.emit('error', err)
        }
      })
  }

  private scheduleProgressCheck = () => {
    this.progressCheckIntervalTimer = setInterval(
      this.progressCheck,
      this.settings.progressInterval
    )
  }

  private stopProgressCheck = () => {
    this.disableProgressChecks = true
    if (this.progressCheckIntervalTimer !== null) {
      clearInterval(this.progressCheckIntervalTimer)
    }
  }
} // --------- Class end ---------------------------------------------

const settingsToArgs = (file: string, settings: PlayerSettings): string[] => [
  `"${file}"`,
  '-o',
  settings.audioOutput,
  settings.noBackgroundColor ? '' : `-b${settings.backgroundColor}`,
  '--dbus_name',
  settings.dBusId,
  settings.loop ? '--loop' : '',
  '--layer',
  settings.layer.toString(),
]
