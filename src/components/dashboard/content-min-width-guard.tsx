/**
 * Container-query guard for the dashboard content pane: below ~360px of
 * available content width (small window or wide chat dock) the page content
 * is display:none'd — staying mounted so form/page state survives transient
 * squeezes — and a notice is shown instead. The nearest @container/content
 * ancestor (the scroll pane in DashboardSplit / the no-assistant layout
 * branch) defines the measured width.
 */
export function ContentMinWidthGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="hidden flex-1 flex-col @[22.5rem]/content:flex">
        {children}
      </div>
      <div className="flex flex-1 items-center justify-center p-6 @[22.5rem]/content:hidden">
        <p className="max-w-[16rem] text-center text-sm text-muted-foreground">
          This view needs a wider window. Enlarge the window or narrow the
          chat panel.
        </p>
      </div>
    </>
  );
}
