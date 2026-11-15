/**
 * 插件根目录解析（宿主侧共享）。
 *
 * 为什么单列一个模块：手写打包器会把源文件拼进**同一个作用域**，同名顶层声明
 * 会直接构建失败（`build.mjs` 有守卫）。根目录解析以前在 reverse 的两个文件里
 * 各写了一份，合并时撞了，这里统一成一份。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件根目录（`lib/index.js` 的上一级）。 */
export function pluginRoot(): string {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  } catch {
    return process.cwd()
  }
}