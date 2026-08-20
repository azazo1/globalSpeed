import { getDefaultFx } from "@/defaults"
import { gvar } from "@/globalVar"
import { AnyDict, CONTEXT_KEYS, State, URLRule, URLStrictness } from "@/types"
import { canUserScript } from "@/utils/browserUtils"
import { hasActiveParts, testURL } from "@/utils/configUtils"
import { isFirefox, isMac, isMobile, listToDict, timeout } from "@/utils/helper"

type UrlRuleBehavior = [
	URLRule["type"][],
	(isfake: boolean, tabId: number, rule: URLRule, override: AnyDict, deets: NavigationDetails) => void,
]

type NavigationDetails = Pick<chrome.webNavigation.WebNavigationTransitionCallbackDetails, "frameId" | "tabId" | "url">

const RULE_BEHAVIORS: UrlRuleBehavior[] = [
	[
		["ON", "OFF"],
		(isFake, t, r, o) => {
			o[`r:${t}:enabled`] = r.type === "ON" ? true : false
			o[`r:${t}:latestViaShortcut`] = false
		},
	],
	[
		["SPEED"],
		(isFake, t, r, o) => {
			o[`r:${t}:speed`] = r.overrideSpeed ?? 1
		},
	],
	[
		["FX"],
		(isFake, t, r, o) => {
			o[`r:${t}:elementFx`] = r.overrideFx?.["elementFx"] || getDefaultFx()
			o[`r:${t}:backdropFx`] = r.overrideFx?.["backdropFx"] || getDefaultFx()
		},
	],
	[
		["JS"],
		async (isFake, t, r, o, d) => {
			if (isFake) return
			if (isFirefox()) {
				await timeout(500)
				chrome.tabs.sendMessage(d.tabId, { type: "RUN_JS", value: r.overrideJs }, { frameId: 0 })
			} else if (canUserScript()) {
				await timeout(500)
				try {
					chrome.userScripts.execute({
						injectImmediately: true,
						js: [{ code: r.overrideJs }],
						world: "MAIN",
						target: {
							tabId: d.tabId,
							frameIds: [0],
						},
					})
				} catch {}
			}
		},
	],
]

/**
 * 白名单模式 (sitesOnly): 未匹配任何规则的网站强制写入的覆盖键.
 * enabled=false 会同时禁用所有效果 (元素效果经 ConfigSync 释放 fxSync, 音频效果经 offscreen 的 updateFx),
 * speed=1 用于展示默认速度, 实际媒体速度由内容脚本在禁用时恢复为 1x.
 */
const SITES_ONLY_OVERRIDE_KEYS = ["enabled", "speed", "latestViaShortcut"] as (keyof AnyDict & string)[]

async function handleNavigation(deets: NavigationDetails, isCommit?: boolean, skipJs = false) {
	if (!(!deets.frameId && deets.tabId && deets.url?.startsWith("http"))) return
	const raw = await gvar.es.getAllUnsafe()
	const rules = getEnabledRules(raw)
	const sitesOnly = !!raw["g:sitesOnly"]
	if (!rules.length && !sitesOnly) return

	let override = {} as AnyDict
	let fakeOverride = {} as AnyDict
	const removeKeys = new Set(CONTEXT_KEYS.map((k) => `r:${deets.tabId}:${k}`))
	let pageTitle: string = undefined
	let anyMatched = false

	for (let rule of rules) {
		const isOnKey = `s:ro:${deets.tabId}:${rule.id}`
		const oldHost = raw[isOnKey] as string

		let match = testURL(deets.url, rule.condition, false)
		if (match && rule.titleRestrict && !deets.frameId) {
			if (pageTitle === undefined) {
				await timeout(2500)
				const tabInfo = await chrome.tabs.get(deets.tabId)
				pageTitle = tabInfo.title || null
			}
			if (!(pageTitle && matchesPageTitle(pageTitle, rule.titleRestrict))) {
				match = false
			}
		}
		if (match) {
			anyMatched = true
			override[isOnKey] = new URL(deets.url).hostname
			let apply = oldHost
				? shouldReApply(
						rule.type === "JS" ? URLStrictness.EVERY_COMMIT : rule.strictness || URLStrictness.DIFFERENT_HOST,
						oldHost,
						override[isOnKey],
						isCommit,
					)
				: true
			let o = apply ? override : fakeOverride
			if (rule.type !== "JS" || !skipJs) {
				RULE_BEHAVIORS.find(([types]) => types.includes(rule.type))?.[1](o === fakeOverride, deets.tabId, rule, o, deets)
			}
		} else {
			raw[isOnKey] && removeKeys.add(isOnKey)
		}
	}

	// 白名单模式: 未匹配任何规则的网站强制禁用 (enabled=false 同时禁用所有效果) 并恢复默认速度.
	if (sitesOnly && !anyMatched) {
		const tabIncipit = `r:${deets.tabId}:`
		SITES_ONLY_OVERRIDE_KEYS.forEach((k) => {
			override[`${tabIncipit}${k}`] = k === "enabled" ? false : k === "speed" ? 1 : false
		})
	}

	const overrideKeys = Object.keys(override)
	;[...overrideKeys, ...Object.keys(fakeOverride)].forEach((k) => removeKeys.delete(k))
	removeKeys.size && gvar.es.set(listToDict([...removeKeys], null))
	overrideKeys.length && gvar.es.set(override)
}

async function reapplySitesOnly() {
	const raw = await gvar.es.getAllUnsafe()
	const rules = getEnabledRules(raw)
	const sitesOnly = !!raw["g:sitesOnly"]

	const tabs = (await chrome.tabs.query({ url: ["https://*/*", "http://*/*"] })) || []

	// 开关关闭且无任何规则: 清除所有标签页可能遗留的白名单覆盖, 恢复默认行为.
	if (!sitesOnly && !rules.length) {
		if (!tabs.length) return
		return gvar.es.set(
			listToDict(
				tabs.flatMap((tab) => SITES_ONLY_OVERRIDE_KEYS.map((k) => `r:${tab.id}:${k}`)),
				null,
			),
		)
	}

	for (let tab of tabs) {
		if (tab.frozen || !tab.url) continue
		await handleNavigation({ tabId: tab.id, url: tab.url, frameId: 0 }, true, true)
	}
}

function matchesPageTitle(pageTitle: string, tagList: string) {
	if (!tagList) return true
	pageTitle = pageTitle.toLocaleLowerCase()
	const tags = getTags(tagList)
	return tags.some((tag) => pageTitle.includes(tag))
}

function getTags(tagList: string) {
	tagList = tagList || ""
	return [
		...new Set(
			tagList
				.toLowerCase()
				.split(/,+\s+/)
				.filter((tag) => tag.trim()),
		),
	]
}

function getEnabledRules(raw: AnyDict) {
	if (raw["g:superDisable"]) return [] as State["rules"]
	return ((raw["g:rules"] || []) as State["rules"]).filter((rule) => rule.enabled && rule.condition && hasActiveParts(rule.condition))
}

function shouldReApply(strictness: URLStrictness, oldHost: string, currentHost: string, isCommit: boolean) {
	if (strictness === URLStrictness.DIFFERENT_HOST) {
		return isCommit && currentHost !== oldHost
	} else if (strictness === URLStrictness.EVERY_COMMIT) {
		return isCommit
	} else if (strictness === URLStrictness.EVERY_NAVIGATION) {
		return true
	}
	return false
}

if (!(isMac() && isMobile()) && chrome.webNavigation?.onCommitted && chrome.webNavigation.onHistoryStateUpdated) {
	chrome.webNavigation.onCommitted.addListener((deets) => handleNavigation(deets, true))
	chrome.webNavigation.onHistoryStateUpdated.addListener((deets) => handleNavigation(deets))
}

// 白名单开关或规则变化时, 立即对所有已打开的标签页重新应用, 无需等待导航.
gvar.es.addWatcher([/^g:(sitesOnly|rules)$/], () => reapplySitesOnly())

// 启动时重新应用白名单状态 (例如浏览器重启后已打开的标签页).
gvar.sess.safeStartupCbs.add(() => reapplySitesOnly())
