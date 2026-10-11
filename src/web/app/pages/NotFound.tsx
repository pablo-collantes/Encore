import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { RLink } from "../components/RLink";

export default function NotFound() {
  return (
    <Empty className="mt-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Compass />
        </EmptyMedia>
        <EmptyTitle>Page not found</EmptyTitle>
        <EmptyDescription>That page doesn't exist, or the link is out of date.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild size="sm">
          <RLink to="/">Back to overview</RLink>
        </Button>
      </EmptyContent>
    </Empty>
  );
}
