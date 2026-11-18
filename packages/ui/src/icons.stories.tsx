import type { Meta, StoryObj } from "@storybook/react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ExternalLinkIcon,
  PinIcon,
  MinusIcon,
  PlusIcon,
  ColumnTypeTextIcon,
  ColumnTypeNumberIcon,
  ColumnTypeBooleanIcon,
  ColumnTypeDateIcon,
  ColumnTypeSelectIcon,
  ColumnTypeIdIcon,
  StatusCheckIcon,
  StatusClockIcon,
  StatusXIcon,
  StatusArrowIcon,
  SectionIcon,
} from "./icons";

function IconGallery() {
  const icons = [
    { name: "ChevronDownIcon", Icon: ChevronDownIcon },
    { name: "ChevronUpIcon", Icon: ChevronUpIcon },
    { name: "ExternalLinkIcon", Icon: ExternalLinkIcon },
    { name: "PinIcon", Icon: PinIcon },
    { name: "MinusIcon", Icon: MinusIcon },
    { name: "PlusIcon", Icon: PlusIcon },
    { name: "ColumnTypeTextIcon", Icon: ColumnTypeTextIcon },
    { name: "ColumnTypeNumberIcon", Icon: ColumnTypeNumberIcon },
    { name: "ColumnTypeBooleanIcon", Icon: ColumnTypeBooleanIcon },
    { name: "ColumnTypeDateIcon", Icon: ColumnTypeDateIcon },
    { name: "ColumnTypeSelectIcon", Icon: ColumnTypeSelectIcon },
    { name: "ColumnTypeIdIcon", Icon: ColumnTypeIdIcon },
    { name: "StatusCheckIcon", Icon: StatusCheckIcon },
    { name: "StatusClockIcon", Icon: StatusClockIcon },
    { name: "StatusXIcon", Icon: StatusXIcon },
    { name: "StatusArrowIcon", Icon: StatusArrowIcon },
  ];

  const sectionIconNames = ["home", "package", "settings", "users", "list"];

  return (
    <div className="grid grid-cols-4 gap-4">
      {icons.map(({ name, Icon }) => (
        <div
          key={name}
          className="flex flex-col items-center gap-2 rounded-lg border border-ui-border/40 p-4"
        >
          <Icon className="h-6 w-6 text-ui-ink" />
          <span className="text-xs text-ui-muted font-mono">{name}</span>
        </div>
      ))}
      {sectionIconNames.map((name) => (
        <div
          key={`section-${name}`}
          className="flex flex-col items-center gap-2 rounded-lg border border-ui-border/40 p-4"
        >
          <SectionIcon name={name} className="h-6 w-6 text-ui-ink" />
          <span className="text-xs text-ui-muted font-mono">SectionIcon({name})</span>
        </div>
      ))}
    </div>
  );
}

const meta: Meta<typeof IconGallery> = {
  title: "Foundations/Icons",
  component: IconGallery,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "SVG icon library used across MasarX UI. " +
          "All icons accept className for sizing and color.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof IconGallery>;

export const Gallery: Story = {};
