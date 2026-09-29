import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Bot,
  ChevronsLeft,
  ChevronsRight,
  GitPullRequest,
  Languages,
  ListChecks,
  LogIn,
  LogOut,
  Menu,
  Moon,
  Package,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { loginUrl } from "@/lib/api.ts";
import { useMe } from "@/lib/queries.ts";
import { useTheme } from "@/lib/theme.ts";

interface NavItem {
  to: string;
  label: string;
  icon: typeof GitPullRequest;
  adminOnly?: boolean;
  match: (pathname: string) => boolean;
}

const NAV: readonly NavItem[] = [
  { to: "/", label: "PR", icon: GitPullRequest, match: (p) => p === "/" || p.startsWith("/pr/") },
  { to: "/mods", label: "模组", icon: Package, match: (p) => p.startsWith("/mods") || p.startsWith("/versions/") },
  { to: "/compare", label: "对比", icon: Languages, match: (p) => p.startsWith("/compare") },
  { to: "/commands", label: "命令", icon: ListChecks, match: (p) => p.startsWith("/commands") },
  { to: "/agent", label: "Agent", icon: Bot, adminOnly: true, match: (p) => p.startsWith("/agent") },
  { to: "/admin", label: "管理", icon: Settings, adminOnly: true, match: (p) => p.startsWith("/admin") },
];

const COLLAPSE_KEY = "cfpa-sidebar";
const LG_MEDIA = "(min-width: 1024px)";

function initialCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "collapsed";
  } catch {
    return false;
  }
}

/** 折叠只发生在 lg 及以上；移动端抽屉始终按展开态渲染。 */
function collapsedOn(collapsed: boolean, classes: string): string | false {
  return collapsed && classes;
}

function useIsLg(): boolean {
  const [isLg, setIsLg] = useState(() => window.matchMedia(LG_MEDIA).matches);
  useEffect(() => {
    const media = window.matchMedia(LG_MEDIA);
    const onChange = () => setIsLg(media.matches);
    media.addEventListener("change", onChange);
    onChange();
    return () => media.removeEventListener("change", onChange);
  }, []);
  return isLg;
}

function Label({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  return (
    <span className={cn("min-w-0 flex-1 whitespace-nowrap text-left transition-opacity duration-200", collapsedOn(collapsed, "lg:opacity-0"))}>
      {children}
    </span>
  );
}

export function AppShell() {
  const { data: me } = useMe();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { theme, toggle } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const isLg = useIsLg();

  const visible = NAV.filter((item) => !item.adminOnly || me?.isAdmin === true);
  const browsing = visible.filter((item) => !item.adminOnly);
  const restricted = visible.filter((item) => item.adminOnly);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "collapsed" : "expanded");
    } catch {}
  }, [collapsed]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const navItem = (item: NavItem) => {
    const active = item.match(pathname);
    return (
      <Link
        key={item.to}
        to={item.to}
        title={collapsed ? item.label : undefined}
        className={cn(
          "flex items-center gap-2.5 overflow-hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-elevated hover:text-fg",
          active && "bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent",
        )}
        aria-current={active ? "page" : undefined}
      >
        <item.icon aria-hidden="true" className="size-4 shrink-0" />
        <Label collapsed={collapsed}>{item.label}</Label>
      </Link>
    );
  };

  const footerRow =
    "flex w-full items-center gap-2.5 overflow-hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-elevated hover:text-fg";

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        跳到主要内容
      </a>

      {mobileOpen && <div aria-hidden="true" className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setMobileOpen(false)} />}

      <aside
        inert={!mobileOpen && !isLg}
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex h-dvh w-50 flex-col overflow-hidden border-r border-line bg-surface transition-[width,transform] duration-200 ease-out",
          collapsed ? "lg:w-13" : "lg:w-40",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
          <Link to="/" className="flex min-w-0 items-center gap-2 text-sm font-semibold" title="CFPA 翻译面板">
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-brand text-brand-fg">CF</span>
            <span className={cn("whitespace-nowrap transition-opacity duration-200", collapsedOn(collapsed, "lg:opacity-0"))}>CFPA 翻译面板</span>
          </Link>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="ml-auto grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-elevated hover:text-fg lg:hidden"
            aria-label="关闭导航"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>

        <nav aria-label="主导航" className="scroll-thin flex flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-2 py-2">
          {browsing.map(navItem)}
          {restricted.length > 0 && (
            <>
              <div className="my-2 border-t border-line" />
              {restricted.map(navItem)}
            </>
          )}
        </nav>

        <div className="shrink-0 border-t border-line p-2">
          {me ? (
            <div className="flex items-center gap-1.5 overflow-hidden px-1.5 py-1.5 text-sm">
              {me.avatarUrl ? (
                <img src={me.avatarUrl} alt="" className="size-6 shrink-0 rounded-full border border-line" />
              ) : (
                <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full border border-line bg-elevated text-[10px]">
                  {me.login.slice(0, 2).toUpperCase()}
                </span>
              )}
              <span className={cn("min-w-0 flex-1 text-left transition-opacity duration-200", collapsedOn(collapsed, "lg:opacity-0"))}>
                <span className="block truncate font-medium text-fg">{me.login}</span>
                <span className="block truncate text-xs text-muted">{me.isAdmin ? "管理员" : "访客"}</span>
              </span>
            </div>
          ) : null}

          <button
            type="button"
            onClick={toggle}
            title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
            className={footerRow}
          >
            {theme === "dark" ? <Sun aria-hidden="true" className="size-4 shrink-0" /> : <Moon aria-hidden="true" className="size-4 shrink-0" />}
            <Label collapsed={collapsed}>{theme === "dark" ? "浅色主题" : "深色主题"}</Label>
          </button>

          {me ? (
            <a href="/auth/logout" className={footerRow} title="退出登录">
              <LogOut aria-hidden="true" className="size-4 shrink-0" />
              <Label collapsed={collapsed}>退出登录</Label>
            </a>
          ) : (
            <a href={loginUrl()} className={footerRow} title="登录">
              <LogIn aria-hidden="true" className="size-4 shrink-0" />
              <Label collapsed={collapsed}>登录</Label>
            </a>
          )}

          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-expanded={!collapsed}
            title={collapsed ? "展开侧边栏" : undefined}
            className={cn(footerRow, "hidden lg:flex")}
          >
            {collapsed ? <ChevronsRight aria-hidden="true" className="size-4 shrink-0" /> : <ChevronsLeft aria-hidden="true" className="size-4 shrink-0" />}
            <Label collapsed={collapsed}>{collapsed ? "展开侧边栏" : "收起侧边栏"}</Label>
          </button>
        </div>
      </aside>

      <div className={cn("flex min-w-0 flex-col transition-[padding] duration-200 ease-out", collapsed ? "lg:pl-13" : "lg:pl-40")}>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-surface/95 px-3 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-expanded={mobileOpen}
            aria-label="打开导航菜单"
            className="grid size-9 place-items-center rounded-md text-muted hover:bg-elevated hover:text-fg"
          >
            <Menu aria-hidden="true" className="size-5" />
          </button>
          <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
            <span className="grid size-7 place-items-center rounded-md bg-brand text-brand-fg">CF</span>
            CFPA 翻译面板
          </Link>
          <button
            type="button"
            onClick={toggle}
            aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
            className="ml-auto grid size-9 place-items-center rounded-md text-muted hover:bg-elevated hover:text-fg"
          >
            {theme === "dark" ? <Sun aria-hidden="true" className="size-4" /> : <Moon aria-hidden="true" className="size-4" />}
          </button>
        </header>

        <main id="main" className="mx-auto w-full max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
