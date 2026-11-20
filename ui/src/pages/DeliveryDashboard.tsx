import { useEffect } from "react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { SeatMonthlyReport } from "@/components/SeatMonthlyReport";

export function DeliveryDashboard() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "席位看板" }]), [setBreadcrumbs]);
  return <div className="mx-auto max-w-7xl p-4 md:p-6">
    {selectedCompanyId && <SeatMonthlyReport key={selectedCompanyId} companyId={selectedCompanyId} />}
  </div>;
}
