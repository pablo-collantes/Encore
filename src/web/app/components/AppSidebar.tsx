import { ChevronsUpDown, LogOut, Settings } from "lucide-react";
import { useLocation } from "react-router";
import { Logo } from "@/auth/Logo";
import { signOut } from "@/auth/api";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { initials } from "../lib/format";
import { displayName, ROLE_LABEL, useMe } from "../lib/me";
import { navFor, visibleNav } from "./nav";
import { RLink } from "./RLink";

export function AppSidebar() {
  const me = useMe();
  const { pathname } = useLocation();
  const active = navFor(pathname);
  const { isMobile, setOpenMobile } = useSidebar();
  const close = () => isMobile && setOpenMobile(false);
  const name = displayName(me);
  const nav = visibleNav(me.role === "admin");

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="Overview">
              <RLink to="/" onClick={close}>
                <Logo className="size-8 shrink-0" />
                <div className="grid leading-tight">
                  <span className="font-heading text-base font-semibold">Encore</span>
                  <span className="text-xs text-muted-foreground">Your Spotify archive</span>
                </div>
              </RLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {nav.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={active?.to === item.to} tooltip={item.label}>
                      <RLink to={item.to} onClick={close}>
                        <item.icon />
                        <span>{item.label}</span>
                      </RLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent" aria-label="Account menu">
                  <Avatar className="size-8 rounded-lg">
                    <AvatarFallback className="rounded-lg">{initials(name)}</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{name}</span>
                    <span className="truncate text-xs text-muted-foreground">{ROLE_LABEL[me.role]}</span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side={isMobile ? "bottom" : "right"} align="end" className="min-w-56">
                <DropdownMenuLabel className="font-normal">
                  <div className="truncate text-sm font-medium">{name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {me.email && me.email !== name ? `${me.email} · ` : ""}
                    {ROLE_LABEL[me.role]}
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <RLink to="/settings" onClick={close}>
                    <Settings /> Settings
                  </RLink>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void signOut()}>
                  <LogOut /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
